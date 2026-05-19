# 1. Sử dụng image Node.js phiên bản nhẹ (alpine) làm nền tảng
FROM node:20-alpine

# 2. Thiết lập thư mục làm việc bên trong container
WORKDIR /usr/src/app

# 3. Copy file cấu hình package vào trước để tận dụng cache của Docker
COPY package*.json ./

# 4. Cài đặt các thư viện (chỉ cài dependencies dùng cho production)
RUN npm install --only=production

# 5. Copy toàn bộ mã nguồn còn lại vào container
COPY . .

# 6. Mở cổng 3000 (Khớp với cổng Express đang chạy)
EXPOSE 3000

# 7. Lệnh khởi chạy ứng dụng khi container bắt đầu
CMD ["node", "index.js"]