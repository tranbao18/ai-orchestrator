require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const Parser = require('rss-parser');
const rssParser = new Parser();

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

// --- ADAPTER CHO ROUTER (GPT & Claude) ---
async function callGPT(prompt) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error("Lỗi OpenAI:", error.message);
        return "Xin lỗi, GPT-4o đang gặp sự cố. Vui lòng kiểm tra lại số dư tài khoản API.";
    }
}

async function callClaude(prompt) {
    try {
        const response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
        });
        return response.content[0].text;
    } catch (error) {
        console.error("Lỗi Claude:", error.message);
        return "Xin lỗi, Claude 3.5 đang gặp sự cố. Vui lòng kiểm tra lại số dư tài khoản API.";
    }
}

// --- WEBHOOK ENDPOINT (Cơ chế chống nghẽn 2 luồng) ---
app.post('/webhook/telegram', (req, res) => {
    // 1. Lập tức trả về 200 OK để chống nghẽn Telegram
    res.sendStatus(200);

    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text;

    // 2. Mở luồng phụ (ngầm) xử lý AI
    (async () => {
        try {
            await axios.post(`${TELEGRAM_API}/sendChatAction`, {
                chat_id: chatId,
                action: 'typing'
            });

            let aiResponse = "";
            let cleanText = userText.trim();

            // --- ROUTER LOGIC ---
            if (cleanText.toLowerCase().startsWith("/gpt ")) {
                console.log("🔀 Định tuyến sang: GPT-4o");
                const prompt = cleanText.substring(5).trim();
                aiResponse = await callGPT(prompt);

            } else if (cleanText.toLowerCase().startsWith("/claude ")) {
                console.log("🔀 Định tuyến sang: Claude 3.5 Sonnet");
                const prompt = cleanText.substring(8).trim();
                aiResponse = await callClaude(prompt);

            } else {
                console.log("🔀 Định tuyến sang: Gemini (Kèm Tool Calling)");
                // Sửa lỗi: Khởi tạo biến model của Gemini ngay tại đây
                const model = genAI.getGenerativeModel({
                    model: "gemini-2.5-flash",
                    tools: tools
                });

                const chat = model.startChat();
                let result = await chat.sendMessage(cleanText);
                aiResponse = result.response.text();

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

            // Gửi tin nhắn trả về Telegram
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