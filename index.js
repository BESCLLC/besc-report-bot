require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;

if (!token || !REPORT_CHANNEL_ID) {
  console.error("❌ Missing BOT_TOKEN or REPORT_CHANNEL_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const userSelections = new Map();
const cooldowns = new Map();

const evmHash = /\b0x[a-fA-F0-9]{64}\b/;
const evmAddr = /\b0x[a-fA-F0-9]{40}\b/;
const solAddr = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

// --- /HELP COMMAND ---
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
`📖 *How to Report an Issue*

1️⃣ Select what you are reporting (/start)  
2️⃣ Paste your wallet address  
3️⃣ Paste your TX hash  
4️⃣ Attach screenshots if needed  
5️⃣ Hit send ✅

Example:
\`\`\`
Bridge issue
Wallet: 0xYourWallet
TX: 0x5094acabef4d0b2b436695a18c4384e4cca834032b159d60a679dc4249b9e622
Amount: 500 USDC
Error: "unknown error"
\`\`\`
`, { parse_mode: "Markdown" });
});

// --- START COMMAND ---
bot.onText(/\/start/, (msg) => {
  const startMessage = `🚨 *BESCswap & BESCbridge Bug Report Bot* 🚨

Please report all issues directly here.

Include:
• Wallet address  
• TX hash  
• For Solana → BESC bridge: Solana address, TX hash, amount, and BESC wallet  
• Any error messages

👇 Select which area your issue relates to:`;

  bot.sendMessage(msg.chat.id, startMessage, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🟣 BESCSWAP', callback_data: 'swap_issue' }],
        [{ text: '🟠 BESCbridge', callback_data: 'bridge_issue' }],
        [{ text: '🟡 wBESC Bridge', callback_data: 'wbesc_issue' }],
        [{ text: '🔧 Other', callback_data: 'other_issue' }],
      ]
    }
  });
});

// --- CALLBACK HANDLER ---
bot.on('callback_query', (cbq) => {
  userSelections.set(cbq.from.id, cbq.data);
  const selectedText = {
    swap_issue: "🟣 *BESCSWAP Selected*\nDescribe your issue:",
    bridge_issue: "🟠 *BESCbridge Selected*\nDescribe your issue:",
    wbesc_issue: "🟡 *wBESC Bridge Selected*\nDescribe your issue:",
    other_issue: "🔧 *Other Selected*\nDescribe your issue:"
  }[cbq.data];

  bot.sendMessage(cbq.message.chat.id, selectedText, { parse_mode: 'Markdown' });
  bot.answerCallbackQuery(cbq.id);
});

// --- MAIN REPORT HANDLER ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text && msg.text.startsWith('/')) return;

  // --- Spam Cooldown ---
  const lastTime = cooldowns.get(msg.from.id) || 0;
  if (Date.now() - lastTime < 5000) {
    return bot.sendMessage(chatId, "⏳ Please wait a few seconds before sending another report.");
  }
  cooldowns.set(msg.from.id, Date.now());

  const category = userSelections.get(msg.from.id) || 'other_issue';
  const categoryLabel = {
    swap_issue: "🟣 *[BESCSWAP ISSUE]*",
    bridge_issue: "🟠 *[BESCbridge ISSUE]*",
    wbesc_issue: "🟡 *[wBESC Bridge ISSUE]*",
    other_issue: "🔧 *[Other]*"
  }[category];

  let report = `${categoryLabel}\n\n👤 [${msg.from.first_name || 'User'}](tg://user?id=${msg.from.id})`;
  report += `\nUsername: @${msg.from.username || 'N/A'}\n\n`;

  // Format TX/Address links
  let txMatch = msg.text?.match(evmHash);
  let addrMatch = msg.text?.match(evmAddr);
  let solMatch = msg.text?.match(solAddr);
  let formattedText = msg.text || "";

  report += `*Report:*\n${formattedText}`;

  // Send to admin channel
  try {
    if (msg.photo) {
      // Consolidate photos: send first one with caption, rest without
      await bot.sendPhoto(REPORT_CHANNEL_ID, msg.photo[msg.photo.length - 1].file_id, {
        caption: report,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(REPORT_CHANNEL_ID, report, { parse_mode: 'Markdown' });
    }

    // Confirmation
    bot.sendMessage(chatId, "✅ Report received. Our team will review and respond.");

    // If TX hash present → reply with chain buttons
    if (txMatch) {
      bot.sendMessage(chatId, "🔎 Select explorer to view TX:", {
        reply_markup: {
          inline_keyboard: [[
            { text: "BscScan", url: `https://bscscan.com/tx/${txMatch[0]}` },
            { text: "Etherscan", url: `https://etherscan.io/tx/${txMatch[0]}` }
          ], [
            { text: "PolygonScan", url: `https://polygonscan.com/tx/${txMatch[0]}` },
            { text: "Arbiscan", url: `https://arbiscan.io/tx/${txMatch[0]}` }
          ], [
            { text: "BESC Explorer", url: `https://explorer.beschyperchain.com/tx/${txMatch[0]}` }
          ]]
        }
      });
    }

    // If no TX/wallet → remind user
    if (!txMatch && !addrMatch && !solMatch) {
      bot.sendMessage(chatId, "⚠️ Please include your TX hash and wallet address so we can fix faster.");
    }

  } catch (err) {
    console.error("Failed to forward report:", err);
    bot.sendMessage(chatId, "⚠️ Failed to submit report. Please try again later.");
  }
});
