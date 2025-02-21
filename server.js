const { Server } = require("ssh2");
const fs = require("fs");
const path = require("path");

// 1) Define our own SFTP status codes
const SFTP_STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
};

// 2) Map of username → password
const USERS = {
  sftp: "getTheFiles",
};

// 3) SFTP root directory (virtual "/")
const SFTP_ROOT = path.join(__dirname, "sftp_data");
if (!fs.existsSync(SFTP_ROOT)) {
  fs.mkdirSync(SFTP_ROOT, { recursive: true });
}

// 4) Host key generation (if not existing)
const HOST_KEY_PATH = path.join(__dirname, "host_key");
if (!fs.existsSync(HOST_KEY_PATH)) {
  require("child_process").execSync(
    `ssh-keygen -t rsa -b 2048 -f "${HOST_KEY_PATH}" -N ""`,
  );
}
const hostKey = fs.readFileSync(HOST_KEY_PATH);

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------

// We'll assign a unique integer ID for each open handle.
let handleCount = 0;

// Keep track of open file/dir handles:
const openFiles = {}; // key: handleId, value: fd
const openDirs = {}; // key: handleId, value: { files: [], index: 0 }

/**
 * Creates a 4-byte Buffer handle for SFTP operations.
 */
function createHandle() {
  const handle = Buffer.alloc(4);
  handle.writeUInt32BE(handleCount++, 0);
  return handle;
}

/**
 * Converts any incoming path from the client into a subpath of `SFTP_ROOT`,
 * removing drive letters and double slashes on Windows.
 */
function toLocalPath(sftpPath) {
  // 1) Convert backslashes to forward slashes:
  let p = sftpPath.replace(/\\/g, "/");

  // 2) If there's a Windows drive letter (e.g. "C:"), strip it
  p = p.replace(/^([A-Za-z]):/, "");

  // 3) Remove leading slashes (treat as relative to SFTP_ROOT)
  p = p.replace(/^\/+/, "");

  // 4) Now join with SFTP_ROOT
  return path.join(SFTP_ROOT, p);
}

// ----------------------------------------------------
// MAIN SERVER
// ----------------------------------------------------
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  console.log("Client connected!");

  client.on("authentication", (ctx) => {
    // Simple user/password check
    if (ctx.method === "password" && USERS[ctx.username] === ctx.password) {
      return ctx.accept();
    }
    return ctx.reject();
  });

  client.on("ready", () => {
    console.log("Client authenticated!");

    client.on("session", (accept, reject) => {
      const session = accept();

      session.on("sftp", (accept, reject) => {
        console.log("SFTP session started!");
        const sftpStream = accept();

        // ---------------------
        // REALPATH
        // ---------------------
        sftpStream.on("REALPATH", (reqid, givenPath) => {
          // If '.' or no path given, just say our root is SFTP_ROOT
          if (!givenPath || givenPath === "." || givenPath === "./") {
            return sftpStream.name(reqid, [
              { filename: "/", longname: "/", attrs: {} },
            ]);
          }

          // Otherwise, convert to local path, but respond with a simple
          // slash-based path for the SFTP environment (e.g. "/folder/sub")
          const localPath = toLocalPath(givenPath);
          let relative = path.relative(SFTP_ROOT, localPath);

          // Ensure we always start with a slash
          relative = relative.replace(/\\/g, "/"); // backslash → forward slash
          if (!relative.startsWith("/")) {
            relative = "/" + relative;
          }

          sftpStream.name(reqid, [
            { filename: relative, longname: relative, attrs: {} },
          ]);
        });

        // ---------------------
        // OPENDIR
        // ---------------------
        sftpStream.on("OPENDIR", (reqid, dirPath) => {
          const fullPath = toLocalPath(dirPath);
          fs.readdir(fullPath, { withFileTypes: true }, (err, dirents) => {
            if (err) {
              console.error("OPENDIR error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            // Prepare an in-memory list of files in this dir
            const fileList = dirents.map((dirent) => {
              const isDir = dirent.isDirectory() ? "d" : "-";
              return {
                filename: dirent.name,
                longname: `${isDir} ${dirent.name}`, // minimal "ls -l" style
                attrs: {},
              };
            });

            const handle = createHandle();
            openDirs[handle.readUInt32BE(0)] = {
              files: fileList,
              index: 0,
            };
            sftpStream.handle(reqid, handle);
          });
        });

        // ---------------------
        // READDIR
        // ---------------------
        sftpStream.on("READDIR", (reqid, handle) => {
          const handleId = handle.readUInt32BE(0);
          const dirData = openDirs[handleId];

          if (!dirData) {
            return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
          }

          // If we've returned all files, send EOF
          if (dirData.index >= dirData.files.length) {
            return sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
          }

          // Return one entry at a time
          const entry = dirData.files[dirData.index++];
          sftpStream.name(reqid, [entry]);
        });

        // ---------------------
        // OPEN (file)
        // ---------------------
        sftpStream.on("OPEN", (reqid, filename, flags, attrs) => {
          const filepath = toLocalPath(filename);
          fs.open(filepath, flags, (err, fd) => {
            if (err) {
              console.error("OPEN error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            const handle = createHandle();
            openFiles[handle.readUInt32BE(0)] = fd;
            sftpStream.handle(reqid, handle);
          });
        });

        // ---------------------
        // CLOSE (file or dir)
        // ---------------------
        sftpStream.on("CLOSE", (reqid, handle) => {
          const handleId = handle.readUInt32BE(0);

          if (openFiles[handleId] !== undefined) {
            // It's a file handle
            const fd = openFiles[handleId];
            delete openFiles[handleId];
            fs.close(fd, (err) => {
              if (err) {
                console.error("CLOSE file error:", err);
                return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
              }
              sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
            });
          } else if (openDirs[handleId] !== undefined) {
            // It's a dir handle
            delete openDirs[handleId];
            sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
          } else {
            // Unknown handle
            sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
          }
        });

        // ---------------------
        // READ (file)
        // ---------------------
        sftpStream.on("READ", (reqid, handle, offset, length) => {
          const handleId = handle.readUInt32BE(0);
          const fd = openFiles[handleId];

          if (fd === undefined) {
            return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
          }

          const buf = Buffer.alloc(length);
          fs.read(fd, buf, 0, length, offset, (err, bytesRead) => {
            if (err) {
              console.error("READ error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            if (bytesRead === 0) {
              // EOF
              return sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
            }
            sftpStream.data(reqid, buf.slice(0, bytesRead));
          });
        });

        // ---------------------
        // WRITE (file)
        // ---------------------
        sftpStream.on("WRITE", (reqid, handle, offset, data) => {
          const handleId = handle.readUInt32BE(0);
          const fd = openFiles[handleId];

          if (fd === undefined) {
            return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
          }

          fs.write(fd, data, 0, data.length, offset, (err, written) => {
            if (err) {
              console.error("WRITE error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
          });
        });

        // ---------------------
        // REMOVE (file)
        // ---------------------
        sftpStream.on("REMOVE", (reqid, filename) => {
          const filepath = toLocalPath(filename);
          fs.unlink(filepath, (err) => {
            if (err) {
              console.error("REMOVE error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
          });
        });

        // ---------------------
        // RENAME (file or dir)
        // ---------------------
        sftpStream.on("RENAME", (reqid, oldPath, newPath) => {
          const oldFullPath = toLocalPath(oldPath);
          const newFullPath = toLocalPath(newPath);
          fs.rename(oldFullPath, newFullPath, (err) => {
            if (err) {
              console.error("RENAME error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
          });
        });

        // ---------------------
        // MKDIR
        // ---------------------
        sftpStream.on("MKDIR", (reqid, dirname, attrs) => {
          const dirPath = toLocalPath(dirname);
          fs.mkdir(dirPath, { recursive: true }, (err) => {
            if (err) {
              console.error("MKDIR error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
          });
        });

        // ---------------------
        // RMDIR
        // ---------------------
        sftpStream.on("RMDIR", (reqid, dirname) => {
          const dirPath = toLocalPath(dirname);
          fs.rmdir(dirPath, (err) => {
            if (err) {
              console.error("RMDIR error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
          });
        });

        // ---------------------
        // STAT / LSTAT / FSTAT
        // ---------------------
        sftpStream.on("STAT", (reqid, pathName) => {
          const fullPath = toLocalPath(pathName);
          fs.stat(fullPath, (err, stats) => {
            if (err) {
              console.error("STAT error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            sftpStream.attrs(reqid, stats);
          });
        });

        sftpStream.on("LSTAT", (reqid, pathName) => {
          const fullPath = toLocalPath(pathName);
          fs.lstat(fullPath, (err, stats) => {
            if (err) {
              console.error("LSTAT error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            sftpStream.attrs(reqid, stats);
          });
        });

        sftpStream.on("FSTAT", (reqid, handle) => {
          const handleId = handle.readUInt32BE(0);
          const fd = openFiles[handleId];

          if (fd === undefined) {
            return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
          }

          fs.fstat(fd, (err, stats) => {
            if (err) {
              console.error("FSTAT error:", err);
              return sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
            }
            sftpStream.attrs(reqid, stats);
          });
        });
      });
    });
  });

  client.on("end", () => {
    console.log("Client disconnected.");
  });
});

server.listen(2222, "0.0.0.0", () => {
  console.log("SFTP server listening on port 2222");
});
