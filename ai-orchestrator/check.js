require('dotenv').config();
const axios = require('axios');

async function checkModels() {
    console.log("Đang tải danh sách mô hình từ Google...");
    try {
        const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);

        console.log("\n=== CÁC MÔ HÌNH HỖ TRỢ TEXT BẠN ĐƯỢC PHÉP DÙNG ===");
        response.data.models.forEach(m => {
            // Chỉ lọc các mô hình hỗ trợ chat/text (generateContent)
            if (m.supportedGenerationMethods.includes("generateContent")) {
                // Xóa chữ "models/" ở đầu để lấy đúng tên cần điền vào code
                console.log(`👉 ${m.name.replace("models/", "")}`);
            }
        });
        console.log("==================================================\n");
    } catch (error) {
        console.error("Lỗi:", error.response ? error.response.data : error.message);
    }
}

checkModels();