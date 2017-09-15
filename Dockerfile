FROM node:latest

RUN npm install -g mie00/scaffolder
ENV NODE_PATH=/usr/local/lib/node_modules
