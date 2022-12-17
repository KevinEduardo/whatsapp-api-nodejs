FROM node:17.2.0-alpine

# Create app directory
WORKDIR /home/node/app

RUN corepack enable
RUN corepack prepare yarn@3.3.0 --activate
RUN npm install -g yarn

# Bundle app source
COPY . .

RUN yarn install
# If you are building your code for production
RUN npm ci --only=production

CMD [ "yarn", "start" ]