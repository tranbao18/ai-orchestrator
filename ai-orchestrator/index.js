require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Parser = require('rss-parser');
const rssParser = new Parser();
const mongoose = require('mongoose');

// 1. Kết nối với MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Đã kết nối thành công với MongoDB Atlas!'))
    .catch(err => console.error('❌ Lỗi kết nối MongoDB:', err));

// 2. Thiết kế bộ khung (Schema) để lưu tin nhắn
const messageSchema = new mongoose.Schema({
    chatId: String, // ID của người chat trên Telegram
    role: String,   // 'user' (người dùng) hoặc 'assistant' (bot AI)
    content: String, // Nội dung tin nhắn
    timestamp: { type: Date, default: Date.now } // Thời gian nhắn
});

// Tạo Model từ Schema
const Message = mongoose.model('Message', messageSchema);

const app = express();
app.use(express.json());

// --- KHỞI TẠO CÁC CLIENT AI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- CẤU HÌNH TELEGRAM ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// --- HÀM TOOL CALLING (Dành cho Gemini) ---
async function getWeather(location) {
    try {
        const res = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=3`);
        return { result: res.data };
    } catch (error) {
        return { error: "Không thể lấy dữ liệu thời tiết lúc này." };
    }
}
async function getNews() {
    try {
        const feed = await rssParser.parseURL('https://vnexpress.net/rss/tin-moi-nhat.rss');
        const topNews = feed.items.slice(0, 10).map(item => `- ${item.title}\n  Link: ${item.link}`).join('\n\n');
        return { result: topNews };
    } catch (error) {
        return { error: "Không thể tải tin tức." };
    }
}
async function getGoldPrice() {
    return { result: "Giá vàng SJC hôm nay (tham khảo): Mua vào 160.5 triệu đồng/lượng, Bán ra 163.5 triệu đồng/lượng." };
}

// Khai báo menu Tools cho Gemini
const tools = [{
    functionDeclarations: [
        {
            name: "getWeather",
            description: "Lấy dự báo thời tiết hiện tại cho một tỉnh, thành phố cụ thể.",
            parameters: {
                type: "OBJECT",
                properties: { location: { type: "STRING", description: "Tên thành phố, ví dụ: Hà Nội, Hồ Chí Minh" } },
                required: ["location"],
            },
        },
        { name: "getNews", description: "Lấy danh sách các tin tức mới nhất trong ngày." },
        { name: "getGoldPrice", description: "Lấy thông tin giá vàng SJC trong nước hôm nay." }
    ]
}];

// --- ADAPTER CHO ROUTER (GPT & Claude) - Nâng cấp nhận Mảng thay vì Chuỗi ---
async function callGPT(messages) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: messages, // Truyền nguyên mảng lịch sử vào
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error("Lỗi OpenAI:", error.message);
        return "Xin lỗi, GPT-4o đang gặp sự cố. Vui lòng kiểm tra lại số dư tài khoản API.";
    }
}

async function callClaude(messages) {
    try {
        // Lọc bỏ những tin nhắn lỗi có role không hợp lệ (nếu có) để tránh Claude báo lỗi
        const validMessages = messages.filter(msg => msg.role === 'user' || msg.role === 'assistant');
        const response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1024,
            messages: validMessages, // Truyền nguyên mảng lịch sử vào
        });
        return response.content[0].text;
    } catch (error) {
        console.error("Lỗi Claude:", error.message);
        return "Xin lỗi, Claude 3.5 đang gặp sự cố. Vui lòng kiểm tra lại API key hoặc số dư.";
    }
}

const ALLOWED_USERS = process.env.ALLOWED_CHAT_IDS ? process.env.ALLOWED_CHAT_IDS.split(',') : [];

// --- WEBHOOK ENDPOINT ---
app.post('/webhook/telegram', (req, res) => {
    // 1. Lập tức trả về 200 OK để chống nghẽn Telegram
    res.sendStatus(200);

    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id.toString();
    const userText = message.text;

    if (!ALLOWED_USERS.includes(chatId)) {
        console.log(`⚠️ Cảnh báo: Truy cập trái phép từ Chat ID: ${chatId}`);
        // Có thể gửi tin nhắn từ chối (hoặc im lặng block luôn để tiết kiệm tài nguyên)
        axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: "⛔ Xin lỗi, bạn không có quyền truy cập vào hệ thống AI này."
        }).catch(err => console.error(err));
        return; // Dừng tiến trình ngay lập tức, KHÔNG cho code chạy xuống phần gọi AI
    }

    // 2. Mở luồng phụ (ngầm) xử lý AI
    (async () => {
        try {
            await axios.post(`${TELEGRAM_API}/sendChatAction`, {
                chat_id: chatId,
                action: 'typing'
            });

            let aiResponse = "";
            let cleanText = userText.trim();
            let currentModel = 'gemini'; // Mặc định là Gemini
            let actualMessage = cleanText;

            // --- KIỂM TRA ĐỊNH TUYẾN ---
            if (cleanText.toLowerCase().startsWith("/gpt ")) {
                currentModel = 'gpt';
                actualMessage = cleanText.substring(5).trim();
                console.log("🔀 Định tuyến sang: GPT-4o");
            } else if (cleanText.toLowerCase().startsWith("/claude ")) {
                currentModel = 'claude';
                actualMessage = cleanText.substring(8).trim();
                console.log("🔀 Định tuyến sang: Claude 3.5 Sonnet");
            } else {
                console.log("🔀 Định tuyến sang: Gemini (Kèm Tool Calling)");
            }

            // --- BƯỚC A: LƯU TIN NHẮN MỚI CỦA USER VÀO DATABASE ---
            await Message.create({ chatId: chatId.toString(), role: 'user', content: actualMessage });

            // --- BƯỚC B: LẤY LỊCH SỬ CHAT TỪ DATABASE ---
            const rawHistory = await Message.find({ chatId: chatId.toString() })
                .sort({ timestamp: -1 })
                .limit(10); // Lấy 10 tin nhắn gần nhất

            rawHistory.reverse(); // Đảo ngược mảng để sắp xếp từ cũ -> mới

            // --- BƯỚC C: XỬ LÝ THEO TỪNG MODEL ---
            if (currentModel === 'gpt') {
                const aiContextMessages = rawHistory.map(msg => ({
                    role: msg.role,
                    content: msg.content
                }));
                aiResponse = await callGPT(aiContextMessages);

            } else if (currentModel === 'claude') {
                const aiContextMessages = rawHistory.map(msg => ({
                    role: msg.role,
                    content: msg.content
                }));
                aiResponse = await callClaude(aiContextMessages);

            } else {
                // Logic cho Gemini (Cần map role assistant -> model)
                // Cắt bỏ phần tử cuối cùng (là tin nhắn hiện tại) ra khỏi lịch sử cũ
                const previousHistory = rawHistory.slice(0, -1).map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                }));

                const model = genAI.getGenerativeModel({
                    model: "gemini-2.5-flash",
                    tools: tools
                });

                const chat = model.startChat({ history: previousHistory });
                let result = await chat.sendMessage(actualMessage);
                aiResponse = result.response.text();

                // Xử lý Tool Calling (Nếu có)
                const call = result.response.functionCalls();
                if (call && call.length > 0) {
                    const functionName = call[0].name;
                    const functionArgs = call[0].args;
                    let apiResponse = {};

                    console.log(`🤖 Đang gọi Tool: ${functionName}`);

                    if (functionName === 'getWeather') apiResponse = await getWeather(functionArgs.location);
                    else if (functionName === 'getNews') apiResponse = await getNews();
                    else if (functionName === 'getGoldPrice') apiResponse = await getGoldPrice();

                    result = await chat.sendMessage([{
                        functionResponse: { name: functionName, response: apiResponse }
                    }]);
                    aiResponse = result.response.text();
                }
            }

            // --- BƯỚC D: LƯU CÂU TRẢ LỜI CỦA BOT VÀO DATABASE ---
            await Message.create({ chatId: chatId.toString(), role: 'assistant', content: aiResponse });

            // --- BƯỚC E: GỬI KẾT QUẢ VỀ TELEGRAM ---
            await axios.post(`${TELEGRAM_API}/sendMessage`, {
                chat_id: chatId,
                text: aiResponse
            });

        } catch (error) {
            console.error("Lỗi xử lý luồng phụ:", error);
            await axios.post(`${TELEGRAM_API}/sendMessage`, {
                chat_id: chatId,
                text: "Xin lỗi, hệ thống AI đang gặp sự cố. Vui lòng thử lại sau!"
            });
        }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});