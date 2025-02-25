FROM node:18-alpine

WORKDIR /api

# 安装curl用于健康检查
RUN apk add --no-cache curl

# 复制package.json和package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制所有源代码
COPY . .

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "server.js"]
