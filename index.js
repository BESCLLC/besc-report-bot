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

function formatDateUTC(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function guessChain(text = "") {
  text = text.toLowerCase();
  if (text.includes("bsc") || text.includes("bnb")) return "BSC";
  if (text.includes("eth") || text.includes("ethereum")) return "ETH";
  if (text.includes("polygon") || text.includes("matic")) return "POLYGON";
  if (text.includes("arb")) return "ARBITRUM";
  if (text.includes("besc")) return "BESC";
  return null;
}

// --- /HELP COMMAND ---
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
`📖 *How to Report an Issue (Step-by-Step)*

✅ Follow this format for fastest resolution:

\`\`\`
1. Select issue type (/start)
2. Paste your wallet address
3. Paste the transaction hash (TX)
4. Tell us what went wrong (include error message)
5. Attach screenshots (optional but helpful)
\`\`\`

🟢 *Example Report:*
Wallet: 0x1234abcd...
TX: 0x5094acabef4d0b2b436695a18c4384e4cca834032b159d60a679dc4249b9e622
Amount: 500 USDC
Error: "Transaction stuck in bridge"
`, { parse_mode: "Markdown" });
});

// --- START COMMAND ---
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
`🚨 *BESCswap & BESCbridge Bug Report Bot* 🚨

To get help quickly, please provide:
• Wallet address  
• Transaction hash (TXN)  
• If Solana → BESC bridge: Solana address + TX + amount + destination wallet  
• Error message or screenshot if possible  

👇 Select what you are reporting:`, {
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
    swap_issue: "🟣 *BESCSWAP Selected*\nPlease describe your issue below 👇",
    bridge_issue: "🟠 *BESCbridge Selected*\nPlease describe your issue below 👇",
    wbesc_issue: "🟡 *wBESC Bridge Selected*\nPlease describe your issue below 👇",
    other_issue: "🔧 *Other Selected*\nPlease describe your issue below 👇"
  }[cbq.data];

  bot.sendMessage(cbq.message.chat.id, selectedText, { parse_mode: 'Markdown' });
  bot.answerCallbackQuery(cbq.id);
});

// --- MAIN REPORT HANDLER ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text && msg.text.startsWith('/')) return;

  const lastTime = cooldowns.get(msg.from.id) || 0;
  if (Date.now() - lastTime < 5000) {
    return bot.sendMessage(chatId, "⏳ Please wait a few seconds before sending another report.");
  }
  cooldowns.set(msg.from.id, Date.now());

  const category = userSelections.get(msg.from.id) || 'other_issue';
  const categoryLabel = {
    swap_issue: "🟣 BESCSWAP",
    bridge_issue: "🟠 BESCbridge",
    wbesc_issue: "🟡 wBESC Bridge",
    other_issue: "🔧 Other"
  }[category];

  const txMatch = msg.text?.match(evmHash);
  const addrMatch = msg.text?.match(evmAddr);
  const solMatch = msg.text?.match(solAddr);
  const guessedChain = guessChain(msg.text);

  let reportTitle = `📌 *[${categoryLabel} ISSUE]${guessedChain ? " – Chain: " + guessedChain : ""}*`;

  let report = `${reportTitle}\n\n`;
  report += `👤 **From:** [${msg.from.first_name || 'User'}](tg://user?id=${msg.from.id})\n`;
  report += `🔗 **Username:** ${msg.from.username ? `[@${msg.from.username}](https://t.me/${msg.from.username})` : 'N/A'}\n`;
  report += `🆔 **Telegram ID:** \`${msg.from.id}\`\n\n`;

  if (addrMatch) report += `💼 **Wallet:** [${addrMatch[0]}](https://bscscan.com/address/${addrMatch[0]})\n`;
  if (txMatch) report += `🔗 **Transaction:** ${txMatch[0]}\n`;
  if (solMatch) report += `🌐 **Solana Address:** [${solMatch[0]}](https://solscan.io/account/${solMatch[0]})\n`;

  report += `📝 **User Message:**\n> ${msg.text || "_No message provided_"}\n\n`;
  report += `📅 **Timestamp:** ${formatDateUTC()}`;

  try {
    if (msg.photo) {
      await bot.sendPhoto(REPORT_CHANNEL_ID, msg.photo[msg.photo.length - 1].file_id, {
        caption: report,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(REPORT_CHANNEL_ID, report, { parse_mode: 'Markdown' });
    }

    bot.sendMessage(chatId, "✅ Your report has been submitted.\nThank you for providing details — our team will review and get back to you.");

    if (txMatch) {
      let buttons;
      switch (guessedChain) {
        case "BSC": buttons = [[{ text: "View on BscScan", url: `https://bscscan.com/tx/${txMatch[0]}` }]]; break;
        case "ETH": buttons = [[{ text: "View on Etherscan", url: `https://etherscan.io/tx/${txMatch[0]}` }]]; break;
        case "POLYGON": buttons = [[{ text: "View on PolygonScan", url: `https://polygonscan.com/tx/${txMatch[0]}` }]]; break;
        case "ARBITRUM": buttons = [[{ text: "View on Arbiscan", url: `https://arbiscan.io/tx/${txMatch[0]}` }]]; break;
        case "BESC": buttons = [[{ text: "View on BESC Explorer", url: `https://explorer.beschyperchain.com/tx/${txMatch[0]}` }]]; break;
        default:
          buttons = [
            [{ text: "BscScan", url: `https://bscscan.com/tx/${txMatch[0]}` }, { text: "Etherscan", url: `https://etherscan.io/tx/${txMatch[0]}` }],
            [{ text: "PolygonScan", url: `https://polygonscan.com/tx/${txMatch[0]}` }, { text: "Arbiscan", url: `https://arbiscan.io/tx/${txMatch[0]}` }],
            [{ text: "BESC Explorer", url: `https://explorer.beschyperchain.com/tx/${txMatch[0]}` }]
          ];
      }
      bot.sendMessage(chatId, "🔎 View your transaction:", { reply_markup: { inline_keyboard: buttons } });
    }

    if (!txMatch && !addrMatch && !solMatch) {
      bot.sendMessage(chatId, "⚠️ Please include your TX hash and wallet address so we can resolve this faster.");
    }

  } catch (err) {
    console.error("Failed to forward report:", err);
    bot.sendMessage(chatId, "⚠️ Failed to submit report. Please try again later.");
  }
});
