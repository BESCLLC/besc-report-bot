require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Optional: Direct admin chat for alerts

if (!token || !REPORT_CHANNEL_ID) {
  console.error("❌ Missing BOT_TOKEN or REPORT_CHANNEL_ID in .env");
  process.exit(1); // Fixed syntax error
}

const bot = new TelegramBot(token, { polling: true });

// Enhanced state management
const userStates = new Map(); // { userId: { state: 'category', data: { category: '', wallet: '', ... } } }
const cooldowns = new Map();
const reportQueue = new Map(); // Temp store for building reports

const evmHash = /\b0x[a-fA-F0-9]{64}\b/;
const evmAddr = /\b0x[a-fA-F0-9]{40}\b/;
const solAddr = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

// Chain explorers mapping for dynamic links
const chainExplorers = {
  BSC: { tx: 'https://bscscan.com/tx/', addr: 'https://bscscan.com/address/' },
  ETH: { tx: 'https://etherscan.io/tx/', addr: 'https://etherscan.io/address/' },
  POLYGON: { tx: 'https://polygonscan.com/tx/', addr: 'https://polygonscan.com/address/' },
  ARBITRUM: { tx: 'https://arbiscan.io/tx/', addr: 'https://arbiscan.io/address/' },
  BESC: { tx: 'https://explorer.beschyperchain.com/tx/', addr: 'https://explorer.beschyperchain.com/address/' },
  SOLANA: { tx: 'https://solscan.io/tx/', addr: 'https://solscan.io/account/' }
};

function formatDateUTC(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function guessChain(text = "") {
  text = text.toLowerCase();
  if (text.includes("solana") || text.includes("sol")) return "SOLANA";
  if (text.includes("bsc") || text.includes("bnb")) return "BSC";
  if (text.includes("eth") || text.includes("ethereum")) return "ETH";
  if (text.includes("polygon") || text.includes("matic")) return "POLYGON";
  if (text.includes("arb")) return "ARBITRUM";
  if (text.includes("besc")) return "BESC";
  return null;
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

// Admin-only commands
function isAdmin(chatId) {
  return ADMIN_CHAT_ID && chatId.toString() === ADMIN_CHAT_ID;
}

// Helper for admin buttons
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

// --- /STATS COMMAND (Admin only) ---
bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const totalReports = Array.from(userStates.values()).filter(s => s.state !== 'idle').length + reportQueue.size;
  const activeUsers = new Set(Array.from(userStates.keys())).size;
  const uptime = process.uptime();
  const uptimeStr = `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  bot.sendMessage(msg.chat.id, 
`📊 *Bot Statistics*

👥 Active Users: ${activeUsers}
📋 Reports in Progress: ${totalReports}
⏱️ Uptime: ${uptimeStr}
💬 Total Cooldowns: ${cooldowns.size}

*Recent Activity:*
• BSC: ${Array.from(userStates.values()).filter(s => s.data.chain === 'BSC').length} reports
• ETH: ${Array.from(userStates.values()).filter(s => s.data.chain === 'ETH').length} reports
• Bridge Issues: ${Array.from(userStates.values()).filter(s => s.data.category === 'bridge_issue').length} reports`, 
{ parse_mode: 'Markdown' });
});

// --- /HELP COMMAND ---
bot.onText(/\/help/, (msg) => {
  const helpText = `📖 *How to Report an Issue (Guided Flow)*

Our bot guides you step-by-step for complete reports:

1️⃣ **Start:** /start → Select issue type
2️⃣ **Wallet:** Provide your wallet address (auto-validated)
3️⃣ **TX Hash:** Paste transaction hash (auto-detected chain)
4️⃣ **Details:** Describe the issue + error messages
5️⃣ **Proof:** Attach screenshots/videos (optional)
6️⃣ **Submit:** Review & send

🟢 *Pro Tips:*
• Include amounts, timestamps, and exact errors
• For Solana → BESC bridges: Provide Solana TX + destination wallet
• Use /cancel to restart anytime
• Bot auto-flags CRITICAL issues (stuck funds, hacks)

🔒 *Privacy:* Your data is securely forwarded to admins only
📊 *Track:* Use /stats (admin only) to monitor

Need more? Reply with questions!`;
  bot.sendMessage(msg.chat.id, helpText, { parse_mode: "Markdown" });
});

// --- /CANCEL COMMAND ---
bot.onText(/\/cancel/, (msg) => {
  resetUserState(msg.from.id);
  bot.sendMessage(msg.chat.id, `🔄 *Report cancelled.* Start over with /start or /help.`, { parse_mode: 'Markdown' });
});

// --- START COMMAND ---
bot.onText(/\/start/, (msg) => {
  resetUserState(msg.from.id);
  setUserState(msg.from.id, 'waiting_category', {});
  bot.sendMessage(msg.chat.id,
`🚨 *Welcome to BESC Bug Report Bot* 🚨

We're here to fix issues fast! Let's get your details.

👇 *Step 1: Select Issue Type*

*Pro Tip:* Bot auto-detects chains (BSC/ETH/Solana) and flags critical issues!`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🟣 BESCSWAP', callback_data: 'swap_issue' }],
        [{ text: '🟠 BESCbridge', callback_data: 'bridge_issue' }],
        [{ text: '🟡 wBESC Bridge', callback_data: 'wbesc_issue' }],
        [{ text: '🔧 Other', callback_data: 'other_issue' }],
        [{ text: '❓ Help', callback_data: 'help' }],
      ]
    }
  });
});

// --- CALLBACK HANDLER ---
bot.on('callback_query', async (cbq) => {
  const userId = cbq.from.id;
  const chatId = cbq.message.chat.id;
  const state = getUserState(userId);

  switch (cbq.data) {
    case 'help':
      await bot.sendMessage(chatId, "📖 Check /help for details!", { parse_mode: 'Markdown' });
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
      await bot.sendMessage(chatId, `${categoryLabel} *selected!*\n\n👤 *Step 2: Provide your Wallet Address*\n\nExamples:\n• EVM: \`0x1234...\` (40 chars)\n• Solana: \`1ABC...\` (32-44 chars)\n\nReply with your address:`, { parse_mode: 'Markdown' });
      break;
    case 'add_more':
      const currentData = getUserState(userId).data;
      setUserState(userId, 'waiting_desc', currentData);
      await bot.sendMessage(chatId, '➕ *Adding to your report.*\nReply with additional info:');
      break;
    case 'status':
      await bot.sendMessage(chatId, '⏳ *Status Update:*\nYour report is under review by our team.\n\nExpect a response within 24h via DM.\n\n💡 *Tip:* Use "add_more" button to provide updates.', { parse_mode: 'Markdown' });
      break;
    case 'admin_stats':
      if (!isAdmin(cbq.message.chat.id)) {
        await bot.answerCallbackQuery(cbq.id, { text: '❌ Admin only!' });
        return;
      }
      await bot.sendMessage(chatId, '📊 Loading stats...', { reply_markup: { inline_keyboard: [] } });
      bot.sendMessage(chatId, '📊 *Stats command triggered* - check recent /stats message.', { parse_mode: 'Markdown' });
      break;
    case /^resolve_(\d+)$/.test(cbq.data) && cbq.data:
      const resolveUserId = cbq.data.split('_')[1];
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { 
        chat_id: cbq.message.chat.id, 
        message_id: cbq.message.message_id 
      });
      await bot.sendMessage(cbq.message.chat.id, `✅ *Report RESOLVED* for user \`${resolveUserId}\`\n\nNotify user via DM.`, { parse_mode: 'Markdown' });
      try {
        await bot.sendMessage(resolveUserId, '🎉 *Great news!* Your BESC issue has been resolved by our team.\n\nCheck your DMs for details.', { parse_mode: 'Markdown' });
      } catch (e) {
        console.log('Could not notify resolved user:', e.message);
      }
      break;
    case /^reopen_(\d+)$/.test(cbq.data) && cbq.data:
      const reopenUserId = cbq.data.split('_')[1];
      await bot.editMessageReplyMarkup(getAdminButtons(reopenUserId), { 
        chat_id: cbq.message.chat.id, 
        message_id: cbq.message.message_id 
      });
      await bot.sendMessage(cbq.message.chat.id, `🔄 *Report REOPENED* for user \`${reopenUserId}\`` , { parse_mode: 'Markdown' });
      break;
    default:
      await bot.answerCallbackQuery(cbq.id, { text: 'Invalid selection.' });
  }
  bot.answerCallbackQuery(cbq.id);
});

// --- MAIN MESSAGE HANDLER ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (msg.text && msg.text.startsWith('/')) {
    return;
  }
  
  if (msg.text && msg.text.toLowerCase() === 'cancel') {
    resetUserState(userId);
    return bot.sendMessage(chatId, `🔄 *Report cancelled.* Start over with /start.`, { parse_mode: 'Markdown' });
  }

  // Cooldown check
  const lastTime = cooldowns.get(userId) || 0;
  if (Date.now() - lastTime < 3000) {
    return bot.sendMessage(chatId, "⏳ Hold on—sending too fast! Wait 3 seconds.");
  }
  cooldowns.set(userId, Date.now());

  const state = getUserState(userId);
  
  // Fallback: Auto-start for TX/address without /start
  const text = (msg.text || '').trim();
  const txMatch = text.match(evmHash);
  const addrMatch = text.match(evmAddr);
  const solMatch = text.match(solAddr);
  
  if (state.state === 'idle' && (txMatch || addrMatch || solMatch)) {
    setUserState(userId, 'waiting_category', { category: 'other_issue' });
    await bot.sendMessage(chatId, `🔍 *Detected transaction data!*\nAuto-assigned to "Other" category.\n\nProceeding to wallet step...`, { parse_mode: 'Markdown' });
  }

  let nextState = state.state;
  let responseText = '';

  // Step: waiting_category
  if (state.state === 'waiting_category' && !msg.text) {
    bot.sendMessage(chatId, `🚨 *Start your report with /start*`, { parse_mode: 'Markdown' });
    return;
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
      responseText = `✅ *Wallet validated:* \`${wallet.slice(0, 10)}...\`\n${chainGuess ? `*Guessed chain:* ${chainGuess}\n` : ''}\n🔗 *Step 3: Provide Transaction Hash (TX)*\n\nPaste your TX hash:\n• EVM: \`0x...\` (64 hex chars)\n• Solana: Base58 signature\n\nReply with TX:`;
      nextState = 'waiting_tx';
    } else {
      responseText = `⚠️ *Invalid wallet format.*\n\n*Examples:*\n• EVM: \`0x1234567890abcdef...\` (exactly 42 chars)\n• Solana: \`9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM\`\n\nTry again:`;
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
      const explorerLink = chainExplorers[chain]?.tx ? `[View TX](${chainExplorers[chain].tx}${tx})` : `\`${tx.slice(0, 10)}...\``;
      responseText = `✅ *TX captured:* ${explorerLink}\n*Chain:* ${chain}\n\n📝 *Step 4: Describe the Issue*\n\n*Please include:*\n• What went wrong?\n• Amount involved\n• Exact error message\n• For bridges: Destination wallet?\n\nReply with description:`;
      nextState = 'waiting_desc';
    } else {
      responseText = `⚠️ *Invalid TX format.*\n\n*Examples:*\n• EVM: \`0x1234567890abcdef...\` (exactly 66 chars)\n• Solana: \`5EyP3MgvCY...\`\n\nTry again:`;
      nextState = 'waiting_tx';
    }
  }

  // Step: waiting_desc
  else if (state.state === 'waiting_desc') {
    const desc = text || '_No description provided_';
    setUserState(userId, 'waiting_attach', { ...state.data, desc });
    responseText = `📝 *Description noted.*\n\n📎 *Step 5: Attach Proof (Optional)*\n\nSend screenshots/videos/documents or type *skip* to submit.\n\n(You can add more later via "Add More Info" button.)`;
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
      // Append to description
      data.desc += `\n\nAdditional: ${text}`;
      setUserState(userId, 'waiting_attach', data);
      responseText = `➕ *Added to description.* Send attachments or type *skip*.`;
      bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown' });
      return;
    }

    // Submit report
    await buildAndSendReport(userId, data, attachments, chatId);
    resetUserState(userId);
    return;
  }

  // Fallback: Append to description
  else {
    responseText = `ℹ️ *Noted:* ${text}\n(Added to your report. Continue with next step or /cancel.)`;
    const data = { ...state.data, desc: (state.data.desc || '') + `\n\nFollow-up: ${text}` };
    setUserState(userId, state.state, data);
  }

  // Send response
  bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown' });
  setUserState(userId, nextState, state.data);
});

// --- REPORT BUILDING & SENDING ---
async function buildAndSendReport(userId, data, attachments = [], userChatId) {
  const user = await bot.getChat(userId);
  const categoryLabel = {
    swap_issue: "🟣 BESCSWAP",
    bridge_issue: "🟠 BESCbridge",
    wbesc_issue: "🟡 wBESC Bridge",
    other_issue: "🔧 Other"
  }[data.category] || 'Unknown';

  // Robust chain guessing + defaults
  let finalChain = data.chain || 'BSC';
  if (data.category === 'swap_issue' && !finalChain.includes('ETH')) {
    finalChain = 'ETH'; // Heuristic: Swaps usually ETH
  }

  // Severity tagging
  const descLower = (data.desc || '').toLowerCase();
  let severity = '🟢 Low';
  if (['stuck', 'lost', 'funds', 'hacked', 'urgent', 'exploit', 'drained'].some(kw => descLower.includes(kw))) {
    severity = '🔴 Critical';
  } else if (['error', 'failed', 'timeout', 'slow'].some(kw => descLower.includes(kw))) {
    severity = '🟡 Medium';
  }

  // Dynamic explorer URLs
  const chain = finalChain;
  const walletExplorer = chainExplorers[chain]?.addr || chainExplorers.BSC.addr;
  const txExplorer = chainExplorers[chain]?.tx || chainExplorers.BSC.tx;

  // Ensure report fits Telegram's 4096-char limit
  let report = `📌 *[${categoryLabel} ISSUE] – ${chain}* ${severity}\n\n`;
  report += `👤 **Reporter:** ${user.first_name || 'User'} ${user.last_name ? `(${user.last_name})` : ''}\n`;
  report += `🔗 **Username:** ${user.username ? `[@${user.username}](tg://user?id=${userId})` : 'N/A'}\n`;
  report += `�ID **Telegram ID:** \`${userId}\`\n`;
  if (data.wallet) {
    report += `💼 **Wallet:** [${data.wallet.slice(0, 8)}...](${walletExplorer}${data.wallet})\n`;
  }
  if (data.tx) {
    report += `🔗 **TX Hash:** [${data.tx.slice(0, 10)}...](${txExplorer}${data.tx})\n`;
  }
  report += `📝 **Description:**\n\`\`\`${data.desc || '_No description provided_'}\`\`\`\n\n`;
  report += `📎 **Attachments:** ${attachments.length}\n`;
  report += `📅 **Submitted:** ${formatDateUTC()}`;

  // Flag incomplete reports
  let completeness = '✅ Complete';
  if (!data.wallet) completeness = '⚠️ MISSING WALLET';
  if (!data.tx) completeness = '⚠️ MISSING TX';
  if (!data.wallet && !data.tx) completeness = '🚨 INCOMPLETE - NEEDS FOLLOWUP';
  report += `\n${completeness}`;

  // Split report if too long (4096-char limit)
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

  try {
    // Send report with attachments as album
    let sentMediaGroupId = null;
    if (attachments.length > 0) {
      const mediaGroup = [];
      for (const att of attachments) {
        if (att.type === 'photo') {
          mediaGroup.push({
            type: 'photo',
            media: att.fileId,
            caption: mediaGroup.length === 0 ? reportMessages[0] : undefined,
            parse_mode: mediaGroup.length === 0 ? 'Markdown' : undefined
          });
        }
      }

      // Send photo album
      if (mediaGroup.length > 0) {
        const sentMessages = await bot.sendMediaGroup(REPORT_CHANNEL_ID, mediaGroup);
        sentMediaGroupId = sentMessages[0].message_id;
        // Send remaining report parts
        for (let i = 1; i < reportMessages.length; i++) {
          await bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
            parse_mode: 'Markdown',
            reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : {}
          });
        }
        // Send non-photo attachments
        for (const att of attachments) {
          if (att.type === 'video') {
            await bot.sendVideo(REPORT_CHANNEL_ID, att.fileId);
          } else if (att.type === 'document') {
            await bot.sendDocument(REPORT_CHANNEL_ID, att.fileId);
          }
        }
      } else {
        // No photos, send first attachment with first report part
        const firstAtt = attachments[0];
        if (firstAtt.type === 'photo') {
          await bot.sendPhoto(REPORT_CHANNEL_ID, firstAtt.fileId, {
            caption: reportMessages[0],
            parse_mode: 'Markdown',
            reply_markup: reportMessages.length === 1 ? getAdminButtons(userId) : {}
          });
        } else if (firstAtt.type === 'video') {
          await bot.sendVideo(REPORT_CHANNEL_ID, firstAtt.fileId, {
            caption: reportMessages[0],
            parse_mode: 'Markdown',
            reply_markup: reportMessages.length === 1 ? getAdminButtons(userId) : {}
          });
        } else {
          await bot.sendDocument(REPORT_CHANNEL_ID, firstAtt.fileId, {
            caption: reportMessages[0],
            parse_mode: 'Markdown',
            reply_markup: reportMessages.length === 1 ? getAdminButtons(userId) : {}
          });
        }
        // Send remaining report parts
        for (let i = 1; i < reportMessages.length; i++) {
          await bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
            parse_mode: 'Markdown',
            reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : {}
          });
        }
        // Send remaining attachments
        for (let i = 1; i < attachments.length; i++) {
          const att = attachments[i];
          if (att.type === 'photo') await bot.sendPhoto(REPORT_CHANNEL_ID, att.fileId);
          else if (att.type === 'video') await bot.sendVideo(REPORT_CHANNEL_ID, att.fileId);
          else await bot.sendDocument(REPORT_CHANNEL_ID, att.fileId);
        }
      }
    } else {
      // No attachments, send text reports
      for (let i = 0; i < reportMessages.length; i++) {
        await bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
          parse_mode: 'Markdown',
          reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : {}
        });
      }
    }

    // Admin alert
    if (ADMIN_CHAT_ID) {
      const alertText = `🔔 New ${severity.includes('Critical') ? '🚨 CRITICAL' : categoryLabel} report from ${user.first_name || userId}`;
      await bot.sendMessage(ADMIN_CHAT_ID, alertText, { 
        reply_markup: { 
          inline_keyboard: [[{ text: 'View Report', url: `https://t.me/c/${REPORT_CHANNEL_ID.slice(4)}` }]] 
        }
      });
    }

    // User confirmation
    const userReview = `✅ *Report Submitted!*\n\n${categoryLabel} – ${chain} ${severity}\n${completeness}\n\nWallet: \`${data.wallet?.slice(0, 10) || 'N/A'}...\`\nTX: \`${data.tx?.slice(0, 10) || 'N/A'}...\`\n\nTeam will review within 24h. Updates via DM.`;
    await bot.sendMessage(userChatId, userReview, { parse_mode: 'Markdown' });

    // User quick actions
    const userButtons = data.tx ? [
      [{ text: `🔍 View ${chain} TX`, url: `${txExplorer}${data.tx}` }],
      [{ text: '📎 Add More Info', callback_data: 'add_more' }],
      [{ text: '❓ Status?', callback_data: 'status' }]
    ] : [
      [{ text: '📎 Add More Info', callback_data: 'add_more' }],
      [{ text: '❓ Status?', callback_data: 'status' }]
    ];
    await bot.sendMessage(userChatId, '💡 *Quick Actions:*', { reply_markup: { inline_keyboard: userButtons } });

  } catch (err) {
    console.error("❌ Report send failed:", err);
    bot.sendMessage(userChatId, "⚠️ Submission error—please /start again or contact admin directly.");
  }
}

// Error handling
bot.on('error', (err) => {
  console.error('Bot error:', err);
});

console.log('🤖 BESC Bug Report Bot started! Polling for updates...');
