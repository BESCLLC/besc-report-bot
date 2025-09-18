require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;

if (!token || !REPORT_CHANNEL_ID) {
  console.error("❌ Missing BOT_TOKEN or REPORT_CHANNEL_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// --- START COMMAND ---
bot.onText(/\/start/, (msg) => {
  const startMessage = `🚨 *BESCswap & BESCbridge Bug Report Bot* 🚨

Please report all issues directly here.

When submitting a report, include:

• Your wallet address  
• Transaction hash (TXN)  
• If it's a Solana → BESC bridge issue:  
  - Solana wallet address  
  - Transaction hash  
  - Amount sent  
  - BESC wallet address to receive BUSDC  
• Any error codes or messages (if applicable)

Providing full info helps us resolve your issue quickly.

👇 Select which area your issue relates to:`;

  const options = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🟣 BESCSWAP', callback_data: 'swap_issue' }],
        [{ text: '🟠 BESCbridge', callback_data: 'bridge_issue' }],
        [{ text: '🟡 wBESC Bridge', callback_data: 'wbesc_issue' }],
        [{ text: '🔧 Other', callback_data: 'other_issue' }],
      ]
    }
  };

  bot.sendMessage(msg.chat.id, startMessage, options);
});

// --- CALLBACK HANDLERS ---
bot.on('callback_query', (cbq) => {
  const selection = cbq.data;
  let responseText = "";

  switch (selection) {
    case 'swap_issue':
      responseText = "🟣 *BESCSWAP Selected*\n\nPlease describe your issue below:";
      break;
    case 'bridge_issue':
      responseText = "🟠 *BESCbridge Selected*\n\nPlease describe your issue below:";
      break;
    case 'wbesc_issue':
      responseText = "🟡 *wBESC Bridge Selected*\n\nPlease describe your issue below:";
      break;
    default:
      responseText = "🔧 *Other Selected*\n\nPlease describe your issue below:";
  }

  bot.sendMessage(cbq.message.chat.id, responseText, { parse_mode: 'Markdown' });
  bot.answerCallbackQuery(cbq.id);
});

// --- REPORT HANDLER (TEXT + PHOTO) ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text && msg.text.startsWith('/')) return;

  let report = `📝 *New BESC Report*\n\n`;
  report += `👤 From: [${msg.from.first_name || 'User'}](tg://user?id=${msg.from.id})\n`;
  report += `Username: @${msg.from.username || 'N/A'}\n\n`;
  if (msg.text) report += `*Report:*\n${msg.text}`;

  try {
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      await bot.sendPhoto(REPORT_CHANNEL_ID, photoId, {
        caption: report,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(REPORT_CHANNEL_ID, report, { parse_mode: 'Markdown' });
    }

    bot.sendMessage(chatId, "✅ Report submitted. Our team will review and respond.");
  } catch (err) {
    console.error("Failed to forward report:", err);
    bot.sendMessage(chatId, "⚠️ Failed to submit report. Please try again later.");
  }
});
