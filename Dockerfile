# Use Node.js LTS version
FROM node:18

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the SFTP server code
COPY . .

# Ensure SSH host key exists
RUN if [ ! -f "host_key" ]; then ssh-keygen -t rsa -b 2048 -f host_key -N ""; fi

# Expose SFTP port
EXPOSE 8080

# Start the SFTP server
CMD ["node", "server.js"]
