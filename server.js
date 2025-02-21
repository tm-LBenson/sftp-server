const { Server } = require("ssh2");
const fs = require("fs");
const path = require("path");

const USERS = {
  sftp: "getTheFiles",
};

const SFTP_ROOT = path.join(__dirname, "sftp_data");
if (!fs.existsSync(SFTP_ROOT)) {
  fs.mkdirSync(SFTP_ROOT, { recursive: true });
}

// Load SSH host key (or generate one if not exists)
const HOST_KEY_PATH = path.join(__dirname, "host_key");
if (!fs.existsSync(HOST_KEY_PATH)) {
  require("child_process").execSync(
    `ssh-keygen -t rsa -b 2048 -f ${HOST_KEY_PATH} -N ""`,
  );
}

const hostKey = fs.readFileSync(HOST_KEY_PATH);

const server = new Server(
  {
    hostKeys: [hostKey],
  },
  (client) => {
    console.log("Client connected!");

    client.on("authentication", (ctx) => {
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
          sftpStream.on("OPEN", (reqid, filename, flags, attrs) => {
            const filepath = path.join(SFTP_ROOT, filename);
            if (flags & fs.constants.O_CREAT) {
              fs.open(filepath, flags, (err, fd) => {
                if (err) return sftpStream.status(reqid, 4); // Failure
                sftpStream.handle(reqid, fd);
              });
            } else {
              sftpStream.status(reqid, 2); // Permission denied
            }
          });

          sftpStream.on("WRITE", (reqid, handle, offset, data) => {
            fs.write(handle, data, 0, data.length, offset, (err) => {
              sftpStream.status(reqid, err ? 4 : 0);
            });
          });

          sftpStream.on("CLOSE", (reqid, handle) => {
            fs.close(handle, (err) => {
              sftpStream.status(reqid, err ? 4 : 0);
            });
          });

          sftpStream.on("REALPATH", (reqid, path) => {
            sftpStream.name(reqid, [{ filename: SFTP_ROOT }]);
          });
        });
      });
    });

    client.on("end", () => {
      console.log("Client disconnected.");
    });
  },
);

server.listen(8080, "0.0.0.0", () => {
  console.log("SFTP server listening on port 8080");
});
