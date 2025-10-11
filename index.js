require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston'); // For structured logging
const axios = require('axios'); // For potential external API calls
const Bottleneck = require('bottleneck'); // For rate limiting

// Initialize logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console()
  ]
});

// Environment variables
const token = process.env.BOT_TOKEN;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!token || !REPORT_CHANNEL_ID) {
  logger.error('Missing BOT_TOKEN or REPORT_CHANNEL_ID in .env');
  process.exit(1);
}

// Rate limiter for Telegram API
const limiter = new Bottleneck({
  minTime: 1000 / 30, // Telegram API limit: ~30 req/s
  maxConcurrent: 1
});

// Initialize bot
const bot = new TelegramBot(token, { polling: true });

// State management
const userStates = new Map(); // { userId: { state: 'category', data: { category: '', wallet: '', ... } } }
const cooldowns = new Map();
const reportQueue = new Map();

// Regex patterns
const evmHash = /\b0x[a-fA-F0-9]{64}\b/;
const evmAddr = /\b0x[a-fA-F0-9]{40}\b/;
const solAddr = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

// Chain explorers with fallback
const chainExplorers = {
  BSC: { tx: 'https://bscscan.com/tx/', addr: 'https://bscscan.com/address/' },
  ETH: { tx: 'https://etherscan.io/tx/', addr: 'https://etherscan.io/address/' },
  POLYGON: { tx: 'https://polygonscan.com/tx/', addr: 'https://polygonscan.com/address/' },
  ARBITRUM: { tx: 'https://arbiscan.io/tx/', addr: 'https://arbiscan.io/address/' },
  BESC: { tx: 'https://explorer.beschyperchain.com/tx/', addr: 'https://explorer.beschyperchain.com/address/' },
  SOLANA: { tx: 'https://solscan.io/tx/', addr: 'https://solscan.io/account/' }
};

// Fallback explorer in case of errors
const fallbackExplorer = {
  tx: 'https://blockscan.com/tx/',
  addr: 'https://blockscan.com/address/'
};

// Utility functions
function formatDateUTC(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function guessChain(text = '') {
  text = text.toLowerCase();
  if (text.includes('solana') || text.includes('sol')) return 'SOLANA';
  if (text.includes('bsc') || text.includes('bnb')) return 'BSC';
  if (text.includes('eth') || text.includes('ethereum')) return 'ETH';
  if (text.includes('polygon') || text.includes('matic')) return 'POLYGON';
  if (text.includes('arb')) return 'ARBITRUM';
  if (text.includes('besc')) return 'BESC';
  return 'BSC'; // Default to BSC for unknown
}

function validateEvmAddress(addr) {
  return evmAddr.test(addr) && addr.length === 42;
}

function validateSolAddress(addr) {
  return solAddr.test(addr) && addr.length >= 32 && addr.length <= 44;
}

function validateEvmTxHash(hash) {
  return evmHash.test(hash);
}

function getUserState(userId) {
  return userStates.get(userId) || { state: 'idle', data: {} };
}

function setUserState(userId, state, data = {}) {
  const current = getUserState(userId);
  userStates.set(userId, { state, data: { ...current.data, ...data } });
}

function resetUserState(userId) {
  userStates.delete(userId);
  cooldowns.delete(userId);
}

function isAdmin(chatId) {
  return ADMIN_CHAT_ID && chatId.toString() === ADMIN_CHAT_ID;
}

function getAdminButtons(userId) {
  return {
    inline_keyboard: [
      [{ text: '✅ Resolved', callback_data: `resolve_${userId}` }],
      [{ text: '👤 Contact User', url: `tg://user?id=${userId}` }],
      [{ text: '🔄 Reopen', callback_data: `reopen_${userId}` }],
      [{ text: '📊 Stats', callback_data: 'admin_stats' }]
    ]
  };
}

// Validate explorer URL availability
async function validateExplorerUrl(url) {
  try {
    const response = await axios.head(url, { timeout: 5000 });
    return response.status < 400;
  } catch (err) {
    logger.warn(`Explorer URL ${url} is unavailable: ${err.message}`);
    return false;
  }
}

// Commands
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg.chat.id)) {
    return bot.sendMessage(msg.chat.id, '❌ Admin only command.', { parse_mode: 'Markdown' });
  }
  const totalReports = Array.from(userStates.values()).filter(s => s.state !== 'idle').length + reportQueue.size;
  const activeUsers = new Set(Array.from(userStates.keys())).size;
  const uptime = process.uptime();
  const uptimeStr = `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  await bot.sendMessage(msg.chat.id,
    `📊 *Bot Statistics*\n\n` +
    `👥 Active Users: ${activeUsers}\n` +
    `📋 Reports in Progress: ${totalReports}\n` +
    `⏱️ Uptime: ${uptimeStr}\n` +
    `💬 Total Cooldowns: ${cooldowns.size}\n\n` +
    `*Recent Activity:*\n` +
    `• BSC: ${Array.from(userStates.values()).filter(s => s.data.chain === 'BSC').length} reports\n` +
    `• ETH: ${Array.from(userStates.values()).filter(s => s.data.chain === 'ETH').length} reports\n` +
    `• Bridge Issues: ${Array.from(userStates.values()).filter(s => s.data.category === 'bridge_issue').length} reports`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, async (msg) => {
  const helpText = `📖 *How to Report an Issue*

Our bot guides you step-by-step:

1️⃣ *Start:* /start → Select issue type
2️⃣ *Wallet:* Provide wallet address (auto-validated)
3️⃣ *TX Hash:* Paste transaction hash (auto-detected chain)
4️⃣ *Details:* Describe the issue + error messages
5️⃣ *Proof:* Attach screenshots/videos (optional)
6️⃣ *Submit:* Review & send

🟢 *Pro Tips:*
• Include amounts, timestamps, and exact errors
• For Solana ↔ BESC bridges: Provide Solana TX + destination wallet
• Use /cancel to restart
• Bot auto-flags CRITICAL issues (stuck funds, hacks)

🔒 *Privacy:* Data securely forwarded to admins only
📊 *Track:* Use /stats (admin only)

Questions? Reply directly!`;
  await bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, async (msg) => {
  resetUserState(msg.from.id);
  await bot.sendMessage(msg.chat.id, `🔄 *Report cancelled.* Start over with /start or /help.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/start/, async (msg) => {
  resetUserState(msg.from.id);
  setUserState(msg.from.id, 'waiting_category', {});
  await bot.sendMessage(msg.chat.id,
    `🚨 *Welcome to BESC Bug Report Bot* 🚨\n\n` +
    `We're here to resolve issues quickly!\n\n` +
    `👇 *Step 1: Select Issue Type*\n\n` +
    `*Pro Tip:* Bot auto-detects chains (BSC/ETH/Solana) and flags critical issues!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🟣 BESCSWAP', callback_data: 'swap_issue' }],
          [{ text: '🟠 BESCbridge', callback_data: 'bridge_issue' }],
          [{ text: '🟡 wBESC Bridge', callback_data: 'wbesc_issue' }],
          [{ text: '🔧 Other', callback_data: 'other_issue' }],
          [{ text: '❓ Help', callback_data: 'help' }]
        ]
      }
    }
  );
});

// Callback handler
bot.on('callback_query', async (cbq) => {
  const userId = cbq.from.id;
  const chatId = cbq.message.chat.id;
  const state = getUserState(userId);

  try {
    switch (cbq.data) {
      case 'help':
        await bot.sendMessage(chatId, '📖 Check /help for details!', { parse_mode: 'Markdown' });
        break;
      case 'swap_issue':
      case 'bridge_issue':
      case 'wbesc_issue':
      case 'other_issue':
        setUserState(userId, 'waiting_wallet', { category: cbq.data });
        const categoryLabel = {
          swap_issue: '🟣 BESCSWAP',
          bridge_issue: '🟠 BESCbridge',
          wbesc_issue: '🟡 wBESC Bridge',
          other_issue: '🔧 Other'
        }[cbq.data];
        await bot.sendMessage(chatId,
          `${categoryLabel} *selected!*\n\n` +
          `👤 *Step 2: Provide Wallet Address*\n\n` +
          `Examples:\n` +
          `• EVM: \`0x1234...\` (40 chars)\n` +
          `• Solana: \`1ABC...\` (32-44 chars)\n\n` +
          `Reply with your address:`,
          { parse_mode: 'Markdown' }
        );
        break;
      case 'add_more':
        setUserState(userId, 'waiting_desc', state.data);
        await bot.sendMessage(chatId, '➕ *Adding to your report.*\nReply with additional info:', { parse_mode: 'Markdown' });
        break;
      case 'status':
        await bot.sendMessage(chatId,
          '⏳ *Status Update:*\n' +
          'Your report is under review.\n' +
          'Expect a response within 24h via DM.\n\n' +
          '💡 *Tip:* Use "Add More Info" to update.',
          { parse_mode: 'Markdown' }
        );
        break;
      case 'admin_stats':
        if (!isAdmin(chatId)) {
          await bot.answerCallbackQuery(cbq.id, { text: '❌ Admin only!' });
          return;
        }
        await bot.sendMessage(chatId, '📊 Loading stats...', { reply_markup: { inline_keyboard: [] } });
        await bot.sendMessage(chatId, '📊 *Stats command triggered* - check recent /stats message.', { parse_mode: 'Markdown' });
        break;
      case /^resolve_(\d+)$/.test(cbq.data) && cbq.data:
        const resolveUserId = cbq.data.split('_')[1];
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: chatId,
          message_id: cbq.message.message_id
        });
        await bot.sendMessage(chatId, `✅ *Report RESOLVED* for user \`${resolveUserId}\`\nNotify user via DM.`, { parse_mode: 'Markdown' });
        try {
          await bot.sendMessage(resolveUserId,
            '🎉 *Great news!* Your BESC issue has been resolved.\nCheck your DMs for details.',
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          logger.error(`Failed to notify user ${resolveUserId}: ${e.message}`);
        }
        break;
      case /^reopen_(\d+)$/.test(cbq.data) && cbq.data:
        const reopenUserId = cbq.data.split('_')[1];
        await bot.editMessageReplyMarkup(getAdminButtons(reopenUserId), {
          chat_id: chatId,
          message_id: cbq.message.message_id
        });
        await bot.sendMessage(chatId, `🔄 *Report REOPENED* for user \`${reopenUserId}\``, { parse_mode: 'Markdown' });
        break;
      default:
        await bot.answerCallbackQuery(cbq.id, { text: 'Invalid selection.' });
    }
    await bot.answerCallbackQuery(cbq.id);
  } catch (err) {
    logger.error(`Callback query error: ${err.message}`, { userId, data: cbq.data });
    await bot.sendMessage(chatId, '⚠️ An error occurred. Please try again or use /start.', { parse_mode: 'Markdown' });
  }
});

// Main message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.text && msg.text.startsWith('/')) return;

  if (msg.text && msg.text.toLowerCase() === 'cancel') {
    resetUserState(userId);
    return bot.sendMessage(chatId, `🔄 *Report cancelled.* Start over with /start.`, { parse_mode: 'Markdown' });
  }

  // Cooldown check
  const lastTime = cooldowns.get(userId) || 0;
  if (Date.now() - lastTime < 3000) {
    return bot.sendMessage(chatId, '⏳ Slow down! Wait 3 seconds before sending again.', { parse_mode: 'Markdown' });
  }
  cooldowns.set(userId, Date.now());

  const state = getUserState(userId);
  const text = (msg.text || '').trim();
  const txMatch = text.match(evmHash);
  const addrMatch = text.match(evmAddr);
  const solMatch = text.match(solAddr);

  // Auto-start for TX/address
  if (state.state === 'idle' && (txMatch || addrMatch || solMatch)) {
    setUserState(userId, 'waiting_category', { category: 'other_issue' });
    await bot.sendMessage(chatId,
      `🔍 *Detected transaction data!*\nAuto-assigned to "Other" category.\nProceeding to wallet step...`,
      { parse_mode: 'Markdown' }
    );
  }

  let nextState = state.state;
  let responseText = '';

  if (state.state === 'waiting_category' && !msg.text) {
    return bot.sendMessage(chatId, `🚨 *Start your report with /start*`, { parse_mode: 'Markdown' });
  }

  // Step: waiting_wallet
  if (state.state === 'waiting_wallet') {
    let wallet = '';
    let isValid = false;
    if (addrMatch && validateEvmAddress(addrMatch[0])) {
      wallet = addrMatch[0];
      isValid = true;
    } else if (solMatch && validateSolAddress(solMatch[0])) {
      wallet = solMatch[0];
      isValid = true;
    }

    if (isValid) {
      setUserState(userId, 'waiting_tx', { ...state.data, wallet });
      const chainGuess = guessChain(text);
      responseText = `✅ *Wallet validated:* \`${wallet.slice(0, 10)}...\`\n` +
                     `${chainGuess ? `*Guessed chain:* ${chainGuess}\n` : ''}\n` +
                     `🔗 *Step 3: Provide Transaction Hash (TX)*\n\n` +
                     `Paste your TX hash:\n` +
                     `• EVM: \`0x...\` (64 hex chars)\n` +
                     `• Solana: Base58 signature\n\n` +
                     `Reply with TX:`;
      nextState = 'waiting_tx';
    } else {
      responseText = `⚠️ *Invalid wallet format.*\n\n` +
                     `*Examples:*\n` +
                     `• EVM: \`0x1234567890abcdef...\` (exactly 42 chars)\n` +
                     `• Solana: \`9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM\`\n\n` +
                     `Try again:`;
      nextState = 'waiting_wallet';
    }
  }

  // Step: waiting_tx
  else if (state.state === 'waiting_tx') {
    let tx = '';
    let chain = guessChain(text) || 'BSC';
    let isValid = false;

    if (txMatch && validateEvmTxHash(txMatch[0])) {
      tx = txMatch[0];
      isValid = true;
    } else if (solMatch && !addrMatch) {
      tx = solMatch[0];
      chain = 'SOLANA';
      isValid = true;
    }

    if (isValid) {
      setUserState(userId, 'waiting_desc', { ...state.data, tx, chain });
      const explorerUrl = (await validateExplorerUrl(chainExplorers[chain]?.tx)) ? chainExplorers[chain].tx : fallbackExplorer.tx;
      const explorerLink = `[View TX](${explorerUrl}${tx})`;
      responseText = `✅ *TX captured:* ${explorerLink}\n` +
                     `*Chain:* ${chain}\n\n` +
                     `📝 *Step 4: Describe the Issue*\n\n` +
                     `*Please include:*\n` +
                     `• What went wrong?\n` +
                     `• Amount involved\n` +
                     `• Exact error message\n` +
                     `• For bridges: Destination wallet?\n\n` +
                     `Reply with description:`;
      nextState = 'waiting_desc';
    } else {
      responseText = `⚠️ *Invalid TX format.*\n\n` +
                     `*Examples:*\n` +
                     `• EVM: \`0x1234567890abcdef...\` (exactly 66 chars)\n` +
                     `• Solana: \`5EyP3MgvCY...\`\n\n` +
                     `Try again:`;
      nextState = 'waiting_tx';
    }
  }

  // Step: waiting_desc
  else if (state.state === 'waiting_desc') {
    const desc = text || '_No description provided_';
    setUserState(userId, 'waiting_attach', { ...state.data, desc });
    responseText = `📝 *Description noted.*\n\n` +
                   `📎 *Step 5: Attach Proof (Optional)*\n\n` +
                   `Send screenshots/videos/documents or type *skip* to submit.\n\n` +
                   `(You can add more later via "Add More Info" button.)`;
    nextState = 'waiting_attach';
  }

  // Step: waiting_attach
  else if (state.state === 'waiting_attach') {
    const data = { ...state.data };
    let attachments = [];

    if (msg.photo) {
      attachments.push({ type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id });
    } else if (msg.video) {
      attachments.push({ type: 'video', fileId: msg.video.file_id });
    } else if (msg.document) {
      attachments.push({ type: 'document', fileId: msg.document.file_id });
    } else if (text.toLowerCase() === 'skip') {
      // Proceed to submit
    } else {
      data.desc += `\n\nAdditional: ${text}`;
      setUserState(userId, 'waiting_attach', data);
      responseText = `➕ *Added to description.* Send attachments or type *skip*.`;
      await bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown' });
      return;
    }

    await limiter.schedule(() => buildAndSendReport(userId, data, attachments, chatId));
    resetUserState(userId);
    return;
  }

  // Fallback: Append to description
  else {
    responseText = `ℹ️ *Noted:* ${text}\n(Added to your report. Continue with next step or /cancel.)`;
    const data = { ...state.data, desc: (state.data.desc || '') + `\n\nFollow-up: ${text}` };
    setUserState(userId, state.state, data);
  }

  await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown' }));
  setUserState(userId, nextState, state.data);
});

// Report building and sending
async function buildAndSendReport(userId, data, attachments = [], userChatId) {
  try {
    const user = await bot.getChat(userId);
    const categoryLabel = {
      swap_issue: '🟣 BESCSWAP',
      bridge_issue: '🟠 BESCbridge',
      wbesc_issue: '🟡 wBESC Bridge',
      other_issue: '🔧 Other'
    }[data.category] || 'Unknown';

    let finalChain = data.chain || 'BSC';
    if (data.category === 'swap_issue' && !finalChain.includes('ETH')) {
      finalChain = 'ETH';
    }

    const descLower = (data.desc || '').toLowerCase();
    let severity = '🟢 Low';
    if (['stuck', 'lost', 'funds', 'hacked', 'urgent', 'exploit', 'drained'].some(kw => descLower.includes(kw))) {
      severity = '🔴 Critical';
    } else if (['error', 'failed', 'timeout', 'slow'].some(kw => descLower.includes(kw))) {
      severity = '🟡 Medium';
    }

    const chain = finalChain;
    const walletExplorer = (await validateExplorerUrl(chainExplorers[chain]?.addr)) ? chainExplorers[chain].addr : fallbackExplorer.addr;
    const txExplorer = (await validateExplorerUrl(chainExplorers[chain]?.tx)) ? chainExplorers[chain].tx : fallbackExplorer.tx;

    let report = `📌 *[${categoryLabel} ISSUE] – ${chain}* ${severity}\n\n` +
                 `👤 **Reporter:** ${user.first_name || 'User'} ${user.last_name ? `(${user.last_name})` : ''}\n` +
                 `🔗 **Username:** ${user.username ? `[@${user.username}](tg://user?id=${userId})` : 'N/A'}\n` +
                 `🆔 **Telegram ID:** \`${userId}\`\n`;
    if (data.wallet) {
      report += `💼 **Wallet:** [${data.wallet.slice(0, 8)}...](${walletExplorer}${data.wallet})\n`;
    }
    if (data.tx) {
      report += `🔗 **TX Hash:** [${data.tx.slice(0, 10)}...](${txExplorer}${data.tx})\n`;
    }
    report += `📝 **Description:**\n\`\`\`${data.desc || '_No description provided_'}\`\`\`\n\n` +
              `📎 **Attachments:** ${attachments.length}\n` +
              `📅 **Submitted:** ${formatDateUTC()}`;

    let completeness = '✅ Complete';
    if (!data.wallet) completeness = '⚠️ MISSING WALLET';
    if (!data.tx) completeness = '⚠️ MISSING TX';
    if (!data.wallet && !data.tx) completeness = '🚨 INCOMPLETE - NEEDS FOLLOWUP';
    report += `\n${completeness}`;

    const MAX_MESSAGE_LENGTH = 4096;
    const reportMessages = [];
    if (report.length > MAX_MESSAGE_LENGTH) {
      let currentMessage = '';
      const lines = report.split('\n');
      for (const line of lines) {
        if (currentMessage.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
          reportMessages.push(currentMessage);
          currentMessage = '';
        }
        currentMessage += line + '\n';
      }
      if (currentMessage) reportMessages.push(currentMessage);
    } else {
      reportMessages.push(report);
    }

    let sentMediaGroupId = null;
    if (attachments.length > 0) {
      const mediaGroup = attachments
        .filter(att => att.type === 'photo')
        .map((att, i) => ({
          type: 'photo',
          media: att.fileId,
          caption: i === 0 ? reportMessages[0] : undefined,
          parse_mode: i === 0 ? 'Markdown' : undefined
        }));

      if (mediaGroup.length > 0) {
        const sentMessages = await limiter.schedule(() => bot.sendMediaGroup(REPORT_CHANNEL_ID, mediaGroup));
        sentMediaGroupId = sentMessages[0].message_id;
        for (let i = 1; i < reportMessages.length; i++) {
          await limiter.schedule(() => bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
            parse_mode: 'Markdown',
            reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : {}
          }));
        }
        for (const att of attachments.filter(a => a.type !== 'photo')) {
          if (att.type === 'video') {
            await limiter.schedule(() => bot.sendVideo(REPORT_CHANNEL_ID, att.fileId));
          } else if (att.type === 'document') {
            await limiter.schedule(() => bot.sendDocument(REPORT_CHANNEL_ID, att.fileId));
          }
        }
      } else {
        const firstAtt = attachments[0];
        const sendMethod = firstAtt.type === 'photo' ? bot.sendPhoto :
                          firstAtt.type === 'video' ? bot.sendVideo : bot.sendDocument;
        await limiter.schedule(() => sendMethod(REPORT_CHANNEL_ID, firstAtt.fileId, {
          caption: reportMessages[0],
          parse_mode: 'Markdown',
          reply_markup: reportMessages.length === 1 ? getAdminButtons(userId) : {}
        }));
        for (let i = 1; i < reportMessages.length; i++) {
          await limiter.schedule(() => bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
            parse_mode: 'Markdown',
            reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : {}
          }));
        }
        for (let i = 1; i < attachments.length; i++) {
          const att = attachments[i];
          if (att.type === 'photo') await limiter.schedule(() => bot.sendPhoto(REPORT_CHANNEL_ID, att.fileId));
          else if (att.type === 'video') await limiter.schedule(() => bot.sendVideo(REPORT_CHANNEL_ID, att.fileId));
          else await limiter.schedule(() => bot.sendDocument(REPORT_CHANNEL_ID, att.fileId));
        }
      }
    } else {
      for (let i = 0; i < reportMessages.length; i++) {
        await limiter.schedule(() => bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
          parse_mode: 'Markdown',
          reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : {}
        }));
      }
    }

    if (ADMIN_CHAT_ID) {
      const alertText = `🔔 New ${severity.includes('Critical') ? '🚨 CRITICAL' : categoryLabel} report from ${user.first_name || userId}`;
      await limiter.schedule(() => bot.sendMessage(ADMIN_CHAT_ID, alertText, {
        reply_markup: {
          inline_keyboard: [[{ text: 'View Report', url: `https://t.me/c/${REPORT_CHANNEL_ID.slice(4)}` }]]
        }
      }));
    }

    const userReview = `✅ *Report Submitted!*\n\n` +
                       `${categoryLabel} – ${chain} ${severity}\n` +
                       `${completeness}\n\n` +
                       `Wallet: \`${data.wallet?.slice(0, 10) || 'N/A'}...\`\n` +
                       `TX: \`${data.tx?.slice(0, 10) || 'N/A'}...\`\n\n` +
                       `Team will review within 24h. Updates via DM.`;
    await limiter.schedule(() => bot.sendMessage(userChatId, userReview, { parse_mode: 'Markdown' }));

    const userButtons = data.tx ? [
      [{ text: `🔍 View ${chain} TX`, url: `${txExplorer}${data.tx}` }],
      [{ text: '📎 Add More Info', callback_data: 'add_more' }],
      [{ text: '❓ Status?', callback_data: 'status' }]
    ] : [
      [{ text: '📎 Add More Info', callback_data: 'add_more' }],
      [{ text: '❓ Status?', callback_data: 'status' }]
    ];
    await limiter.schedule(() => bot.sendMessage(userChatId, '💡 *Quick Actions:*', {
      reply_markup: { inline_keyboard: userButtons }
    }));

  } catch (err) {
    logger.error(`Report send failed for user ${userId}: ${err.message}`, { data, attachments });
    await limiter.schedule(() => bot.sendMessage(userChatId,
      '⚠️ Submission error—please /start again or contact admin directly.',
      { parse_mode: 'Markdown' }
    ));
  }
}

// Global error handling
bot.on('polling_error', (err) => {
  logger.error(`Polling error: ${err.message}`, { stack: err.stack });
});

bot.on('error', (err) => {
  logger.error(`Bot error: ${err.message}`, { stack: err.stack });
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled rejection: ${reason}`, { promise });
});

logger.info('🤖 BESC Bug Report Bot started! Polling for updates...');
