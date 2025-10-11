require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');
const axios = require('axios');
const Bottleneck = require('bottleneck');

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
  minTime: 1000 / 30, // ~30 req/s
  maxConcurrent: 1
});

// Initialize bot
const bot = new TelegramBot(token, { polling: true });

// State management
const userStates = new Map();
const cooldowns = new Map();
const reportQueue = new Map();
const explorerCache = new Map(); // Cache for explorer URL validation

// Regex patterns
const evmHash = /\b0x[a-fA-F0-9]{64}\b/;
const evmAddr = /\b0x[a-fA-F0-9]{40}\b/;
const solAddr = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

// Chain explorers
const chainExplorers = {
  BSC: { base: 'https://bscscan.com', tx: '/tx/', addr: '/address/' },
  ETH: { base: 'https://etherscan.io', tx: '/tx/', addr: '/address/' },
  POLYGON: { base: 'https://polygonscan.com', tx: '/tx/', addr: '/address/' },
  ARBITRUM: { base: 'https://arbiscan.io', tx: '/tx/', addr: '/address/' },
  AVALANCHE: { base: 'https://snowtrace.io', tx: '/tx/', addr: '/address/' },
  OPTIMISM: { base: 'https://optimistic.etherscan.io', tx: '/tx/', addr: '/address/' },
  BASE: { base: 'https://basescan.org', tx: '/tx/', addr: '/address/' },
  BESC: { base: 'https://explorer.beschyperchain.com', tx: '/tx/', addr: '/address/' },
  SOLANA: { base: 'https://solscan.io', tx: '/tx/', addr: '/account/' }
};

const fallbackExplorer = {
  base: 'https://blockscan.com',
  tx: '/tx/',
  addr: '/address/'
};

// Supported chains per category
const supportedChains = {
  swap_issue: ['BSC', 'ETH', 'BESC'],
  other_issue: Object.keys(chainExplorers),
  bridge_issue: ['POLYGON', 'SOLANA', 'ETH', 'BSC', 'ARBITRUM', 'AVALANCHE', 'OPTIMISM', 'BASE'],
  wbesc_issue: ['ETH', 'BSC'],
  moneyx_issue: ['BSC', 'ETH', 'BESC'],
  casino_issue: ['SOLANA', 'BSC', 'ETH']
};

// Utility functions
function formatDateUTC(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
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

async function validateExplorerUrl(url) {
  if (explorerCache.has(url)) {
    return explorerCache.get(url);
  }
  try {
    const response = await axios.head(url, {
      timeout: 5000,
      headers: { 'User-Agent': 'BESCReportBot/1.0.2 (Node.js)' }
    });
    const isValid = response.status < 400;
    explorerCache.set(url, isValid);
    return isValid;
  } catch (err) {
    logger.warn(`Explorer URL ${url} is unavailable: ${err.message}`);
    explorerCache.set(url, false);
    return false;
  }
}

function isBridgeCategory(category) {
  return category === 'bridge_issue' || category === 'wbesc_issue';
}

// Auto-suggest solutions based on description
function suggestSolutions(desc, category) {
  const lowerDesc = desc.toLowerCase();
  const solutions = [];

  if (lowerDesc.includes('unexpected error')) {
    solutions.push('⚠️ "Unexpected error" detected. Try refreshing the page, clearing browser cache, or switching browsers. Ensure wallet is connected.');
  }
  if (lowerDesc.includes('page not found') || lowerDesc.includes('404')) {
    solutions.push('🛑 "Page not found" error. Verify the URL (e.g., bescbridge.com). Check BESC X (@BESCLLC) for downtime notices.');
  }
  if (lowerDesc.includes('solscan') && lowerDesc.includes('404')) {
    solutions.push('🔍 Solscan 404 error. Ensure the Solana TX hash is correct. Try alternative explorers like solana.fm.');
  }
  if (category === 'bridge_issue' || category === 'wbesc_issue') {
    if (lowerDesc.includes('stuck') || lowerDesc.includes('pending')) {
      solutions.push('⏳ Transaction stuck? Check source chain explorer (e.g., Etherscan). Increase gas or wait 30 mins. Contact support with TX hash.');
    }
    if (lowerDesc.includes('not arrived') || lowerDesc.includes('missing')) {
      solutions.push('💸 Funds not arrived? Verify destination address. Wait 5-30 mins for cross-chain confirmation. Provide both TX hashes.');
    }
  }
  if (category === 'moneyx_issue') {
    if (lowerDesc.includes('trade') || lowerDesc.includes('perp')) {
      solutions.push('📈 MoneyX trading issue? Check margin balance and leverage settings. Ensure sufficient funds for fees.');
    }
  }
  if (category === 'casino_issue') {
    if (lowerDesc.includes('usdc') || lowerDesc.includes('balance')) {
      solutions.push('🎰 Casino USDC issue? Verify USDC approval on Solana/BSC/ETH. Check wallet balance and chain compatibility.');
    }
  }

  return solutions.length > 0 ? solutions.join('\n') : 'ℹ️ No specific solutions detected. Please provide more details or attach screenshots.';
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

  await limiter.schedule(() => bot.sendMessage(msg.chat.id,
    `📊 *Bot Statistics*\n\n` +
    `👥 Active Users: ${activeUsers}\n` +
    `📋 Reports in Progress: ${totalReports}\n` +
    `⏱️ Uptime: ${uptimeStr}\n` +
    `💬 Total Cooldowns: ${cooldowns.size}\n\n` +
    `*Recent Activity:*\n` +
    `• BSC: ${Array.from(userStates.values()).filter(s => s.data.sourceChain === 'BSC' || s.data.chain === 'BSC').length} reports\n` +
    `• ETH: ${Array.from(userStates.values()).filter(s => s.data.sourceChain === 'ETH' || s.data.chain === 'ETH').length} reports\n` +
    `• Bridge Issues: ${Array.from(userStates.values()).filter(s => isBridgeCategory(s.data.category)).length} reports\n` +
    `• MoneyX: ${Array.from(userStates.values()).filter(s => s.data.category === 'moneyx_issue').length} reports\n` +
    `• Casino: ${Array.from(userStates.values()).filter(s => s.data.category === 'casino_issue').length} reports`,
    { parse_mode: 'Markdown' }
  ));
});

bot.onText(/\/help/, async (msg) => {
  const helpText = `📖 *How to Report an Issue*\n\n` +
                   `Our bot guides you step-by-step:\n\n` +
                   `1️⃣ *Start:* /start → Select issue type (e.g., Bridge, MoneyX, Casino)\n` +
                   `2️⃣ *For Bridges:* Select direction (to/from BESC) and external chain\n` +
                   `3️⃣ *For Others:* Select chain\n` +
                   `4️⃣ *Wallet:* Provide wallet address\n` +
                   `5️⃣ *Source TX:* Paste source transaction hash\n` +
                   `6️⃣ *Dest TX:* Paste destination TX (bridges only, optional)\n` +
                   `7️⃣ *Details:* Describe issue (e.g., "unexpected error", amount, timestamp)\n` +
                   `8️⃣ *Proof:* Attach screenshots/videos or type *skip*\n` +
                   `9️⃣ *Submit:* Review & send\n\n` +
                   `🟢 *Pro Tips:*\n` +
                   `• Include exact errors (e.g., "page not found"), amounts, and TX hashes\n` +
                   `• For bridges: Specify destination wallet if different\n` +
                   `• MoneyX: Mention perp trading details\n` +
                   `• Casino: Note USDC chain (Solana/BSC/ETH)\n` +
                   `• Use /cancel to restart\n\n` +
                   `🔒 *Privacy:* Data sent to admins only\n` +
                   `📊 *Track:* Use /stats (admin only)\n\n` +
                   `Questions? Reply or contact @BESCLLC on X!`;
  await limiter.schedule(() => bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' }));
});

bot.onText(/\/cancel/, async (msg) => {
  resetUserState(msg.from.id);
  await limiter.schedule(() => bot.sendMessage(msg.chat.id, `🔄 *Report cancelled.* Start over with /start or /help.`, { parse_mode: 'Markdown' }));
});

bot.onText(/\/start/, async (msg) => {
  resetUserState(msg.from.id);
  setUserState(msg.from.id, 'waiting_category', {});
  await limiter.schedule(() => bot.sendMessage(msg.chat.id,
    `🚨 *Welcome to BESC Bug Report Bot* 🚨\n\n` +
    `Resolve issues fast for bridges, MoneyX, Casino, and more!\n\n` +
    `👇 *Step 1: Select Issue Type*\n\n` +
    `*Pro Tip:* We’ll ask for chains and directions to make it easy!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🟣 BESCSWAP', callback_data: 'swap_issue' }],
          [{ text: '🟠 BESCbridge', callback_data: 'bridge_issue' }],
          [{ text: '🟡 wBESC Bridge', callback_data: 'wbesc_issue' }],
          [{ text: '📈 MoneyX (Perps)', callback_data: 'moneyx_issue' }],
          [{ text: '🎰 Casino (USDC)', callback_data: 'casino_issue' }],
          [{ text: '🔧 Other', callback_data: 'other_issue' }],
          [{ text: '❓ Help', callback_data: 'help' }]
        ]
      }
    }
  ));
});

// Callback handler
bot.on('callback_query', async (cbq) => {
  const userId = cbq.from.id;
  const chatId = cbq.message.chat.id;
  const state = getUserState(userId);
  const data = cbq.data;

  try {
    if (data === 'help') {
      await limiter.schedule(() => bot.sendMessage(chatId, '📖 Check /help for details!', { parse_mode: 'Markdown' }));
    } else if (/^resolve_/.test(data)) {
      const resolveUserId = data.split('_')[1];
      await limiter.schedule(() => bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: cbq.message.message_id
      }));
      await limiter.schedule(() => bot.sendMessage(chatId, `✅ *Report RESOLVED* for user \`${resolveUserId}\`\nNotify user via DM.`, { parse_mode: 'Markdown' }));
      try {
        await limiter.schedule(() => bot.sendMessage(resolveUserId,
          '🎉 *Great news!* Your BESC issue has been resolved.\nCheck your DMs or contact @BESCLLC for details.',
          { parse_mode: 'Markdown' }
        ));
      } catch (e) {
        logger.error(`Failed to notify user ${resolveUserId}: ${e.message}`);
      }
    } else if (/^reopen_/.test(data)) {
      const reopenUserId = data.split('_')[1];
      await limiter.schedule(() => bot.editMessageReplyMarkup(getAdminButtons(reopenUserId), {
        chat_id: chatId,
        message_id: cbq.message.message_id
      }));
      await limiter.schedule(() => bot.sendMessage(chatId, `🔄 *Report REOPENED* for user \`${reopenUserId}\``, { parse_mode: 'Markdown' }));
    } else if (data === 'admin_stats') {
      if (!isAdmin(chatId)) {
        await bot.answerCallbackQuery(cbq.id, { text: '❌ Admin only!' });
        return;
      }
      await limiter.schedule(() => bot.sendMessage(chatId, '📊 Loading stats...', { parse_mode: 'Markdown' }));
      await limiter.schedule(() => bot.sendMessage(chatId, '📊 *Stats command triggered* - check recent /stats message.', { parse_mode: 'Markdown' }));
    } else if (['swap_issue', 'bridge_issue', 'wbesc_issue', 'moneyx_issue', 'casino_issue', 'other_issue'].includes(data)) {
      const categoryLabel = {
        swap_issue: '🟣 BESCSWAP',
        bridge_issue: '🟠 BESCbridge',
        wbesc_issue: '🟡 wBESC Bridge',
        moneyx_issue: '📈 MoneyX (Perps)',
        casino_issue: '🎰 Casino (USDC)',
        other_issue: '🔧 Other'
      }[data];
      setUserState(userId, isBridgeCategory(data) ? 'waiting_direction' : 'waiting_chain', { category: data });
      if (isBridgeCategory(data)) {
        await limiter.schedule(() => bot.editMessageText(`${categoryLabel} *selected!*\n\n👇 *Step 2: Select Direction*`, {
          chat_id: chatId,
          message_id: cbq.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '➡️ To BESC Hyperchain', callback_data: 'direction_to' }],
              [{ text: '⬅️ From BESC Hyperchain', callback_data: 'direction_from' }]
            ]
          }
        }));
      } else {
        const chains = supportedChains[data];
        const keyboard = chains.map(c => [{ text: c, callback_data: `chain_${c}` }]);
        await limiter.schedule(() => bot.editMessageText(`${categoryLabel} *selected!*\n\n👇 *Step 2: Select Chain*`, {
          chat_id: chatId,
          message_id: cbq.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }));
      }
    } else if (data.startsWith('direction_')) {
      const direction = data === 'direction_to' ? 'to BESC' : 'from BESC';
      setUserState(userId, 'waiting_external_chain', { ...state.data, direction });
      const chains = supportedChains[state.data.category];
      const keyboard = chains.map(c => [{ text: c, callback_data: `extchain_${c}` }]);
      await limiter.schedule(() => bot.editMessageText(`Direction: *${direction}*\n\n👇 *Step 3: Select External Chain*`, {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }));
    } else if (data.startsWith('extchain_')) {
      const extChain = data.split('_')[1];
      let sourceChain, destChain;
      if (state.data.direction === 'to BESC') {
        sourceChain = extChain;
        destChain = 'BESC';
      } else {
        sourceChain = 'BESC';
        destChain = extChain;
      }
      setUserState(userId, 'waiting_wallet', { ...state.data, sourceChain, destChain });
      await limiter.schedule(() => bot.editMessageText(`Chains: *${sourceChain} → ${destChain}*\n\n👤 *Step 4: Provide Wallet Address*\n\nExamples:\n• EVM: \`0x1234...\`\n• Solana: \`1ABC...\`\n\nReply with your address:`, {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] }
      }));
    } else if (data.startsWith('chain_')) {
      const chain = data.split('_')[1];
      setUserState(userId, 'waiting_wallet', { ...state.data, chain });
      await limiter.schedule(() => bot.editMessageText(`Chain: *${chain}*\n\n👤 *Step 3: Provide Wallet Address*\n\nExamples:\n• EVM: \`0x1234...\`\n• Solana: \`1ABC...\`\n\nReply with your address:`, {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] }
      }));
    } else if (data === 'add_more') {
      setUserState(userId, 'waiting_desc', state.data);
      await limiter.schedule(() => bot.sendMessage(chatId, '➕ *Adding to your report.*\nReply with additional info:', { parse_mode: 'Markdown' }));
    } else if (data === 'status') {
      await limiter.schedule(() => bot.sendMessage(chatId,
        '⏳ *Status Update:*\n' +
        'Your report is under review.\n' +
        'Expect a response within 24h via DM or check @BESCLLC on X.\n\n' +
        '💡 *Tip:* Use "Add More Info" to update.',
        { parse_mode: 'Markdown' }
      ));
    } else if (data === 'skip_tx' || data === 'skip_attach') {
      const nextState = data === 'skip_tx' && isBridgeCategory(state.data.category) ? 'waiting_dest_tx' : 
                        data === 'skip_tx' ? 'waiting_desc' : 'waiting_attach';
      if (nextState === 'waiting_dest_tx') {
        setUserState(userId, nextState, { ...state.data, sourceTx: null });
        await limiter.schedule(() => bot.sendMessage(chatId,
          `✅ *Source TX skipped.*\n\n🔗 *Next: Provide Destination TX Hash for ${state.data.destChain} if known*\n\nReply with dest TX or type *skip*:`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }
        ));
      } else if (nextState === 'waiting_desc') {
        setUserState(userId, nextState, { ...state.data, sourceTx: null });
        await limiter.schedule(() => bot.sendMessage(chatId,
          `✅ *Source TX skipped.*\n\n📝 *Next: Describe the Issue*\n\n` +
          `*Please include:*\n` +
          `• What went wrong? (e.g., "unexpected error")\n` +
          `• Amount involved\n` +
          `• Exact error message\n` +
          `• For bridges: Destination wallet if different\n` +
          `• For MoneyX: Trading details\n` +
          `• For Casino: USDC chain\n\n` +
          `Reply with description:`,
          { parse_mode: 'Markdown' }
        ));
      } else {
        await buildAndSendReport(userId, state.data, state.data.attachments || [], chatId);
        resetUserState(userId);
      }
    } else {
      await bot.answerCallbackQuery(cbq.id, { text: 'Invalid selection.' });
    }
    await bot.answerCallbackQuery(cbq.id);
  } catch (err) {
    logger.error(`Callback query error: ${err.message}`, { userId, data });
    await limiter.schedule(() => bot.sendMessage(chatId, '⚠️ An error occurred. Please try again or use /start.', { parse_mode: 'Markdown' }));
  }
});

// Main message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.text && msg.text.startsWith('/')) return;

  if (msg.text && msg.text.toLowerCase() === 'cancel') {
    resetUserState(userId);
    return limiter.schedule(() => bot.sendMessage(chatId, `🔄 *Report cancelled.* Start over with /start.`, { parse_mode: 'Markdown' }));
  }

  // Cooldown check
  const lastTime = cooldowns.get(userId) || 0;
  if (Date.now() - lastTime < 3000) {
    return limiter.schedule(() => bot.sendMessage(chatId, '⏳ Slow down! Wait 3 seconds before sending again.', { parse_mode: 'Markdown' }));
  }
  cooldowns.set(userId, Date.now());

  const state = getUserState(userId);
  const text = (msg.text || '').trim();
  const lowerText = text.toLowerCase();
  const txMatch = text.match(evmHash);
  const addrMatch = text.match(evmAddr);
  const solMatch = text.match(solAddr);

  // Auto-start for TX/address
  if (state.state === 'idle' && (txMatch || addrMatch || solMatch)) {
    setUserState(userId, 'waiting_category', { category: 'other_issue' });
    await limiter.schedule(() => bot.sendMessage(chatId,
      `🔍 *Detected transaction data!*\nAuto-assigned to "Other" category.\nProceeding...`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Continue', callback_data: 'other_issue' }]] } }
    ));
    return;
  }

  let responseText = '';

  if (state.state === 'waiting_category' && !msg.text) {
    return limiter.schedule(() => bot.sendMessage(chatId, `🚨 *Start your report with /start*`, { parse_mode: 'Markdown' }));
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
      isValid = state.data.sourceChain === 'SOLANA' || state.data.destChain === 'SOLANA' || state.data.chain === 'SOLANA';
    }

    if (isValid) {
      setUserState(userId, 'waiting_source_tx', { ...state.data, wallet });
      responseText = `✅ *Wallet validated:* \`${wallet.slice(0, 10)}...\`\n\n` +
                     `🔗 *Next: Provide Source Transaction Hash (TX)*\n\n` +
                     `Paste your source TX hash for ${state.data.sourceChain || state.data.chain}:\n` +
                     `• EVM: \`0x...\` (64 hex chars)\n` +
                     `• Solana: Base58 signature\n\n` +
                     `Reply with TX or type *skip* if unknown:`;
    } else {
      responseText = `⚠️ *Invalid wallet format for ${state.data.sourceChain || state.data.chain}.*\n\n` +
                     `*Examples:*\n` +
                     `• EVM: \`0x1234567890abcdef...\` (exactly 42 chars)\n` +
                     `• Solana: \`9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM\`\n\n` +
                     `Try again:`;
    }
    await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }));
    return;
  }

  // Step: waiting_source_tx
  if (state.state === 'waiting_source_tx') {
    let tx = '';
    let isValid = false;
    const chain = state.data.sourceChain || state.data.chain;
    const isSol = chain === 'SOLANA';

    if (lowerText === 'skip') {
      isValid = true;
    } else if ((isSol ? solMatch : txMatch)) {
      tx = isSol ? solMatch[0] : txMatch[0];
      isValid = isSol ? true : validateEvmTxHash(tx);
    }

    if (isValid) {
      const nextState = isBridgeCategory(state.data.category) ? 'waiting_dest_tx' : 'waiting_desc';
      setUserState(userId, nextState, { ...state.data, sourceTx: tx || null });
      responseText = `✅ *Source TX ${tx ? 'captured' : 'skipped'}:* \`${tx ? tx.slice(0, 10) : 'N/A'}...\`\n\n`;
      if (nextState === 'waiting_dest_tx') {
        responseText += `🔗 *Next: Provide Destination TX Hash for ${state.data.destChain} if known*\n\n` +
                        `Reply with dest TX or type *skip*:`;
      } else {
        responseText += `📝 *Next: Describe the Issue*\n\n` +
                        `*Please include:*\n` +
                        `• What went wrong? (e.g., "unexpected error")\n` +
                        `• Amount involved\n` +
                        `• Exact error message\n` +
                        `• For bridges: Destination wallet if different\n` +
                        `• For MoneyX: Trading details\n` +
                        `• For Casino: USDC chain\n\n` +
                        `Reply with description:`;
      }
    } else {
      responseText = `⚠️ *Invalid TX format for ${chain}.* Type *skip* if unknown.\n\n` +
                     `*Examples:*\n` +
                     `• EVM: \`0x1234567890abcdef...\` (exactly 66 chars)\n` +
                     `• Solana: \`5EyP3MgvCY...\`\n\n` +
                     `Try again or skip:`;
    }
    await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }));
    return;
  }

  // Step: waiting_dest_tx
  if (state.state === 'waiting_dest_tx') {
    let tx = '';
    let isValid = false;
    const chain = state.data.destChain;
    const isSol = chain === 'SOLANA';

    if (lowerText === 'skip') {
      isValid = true;
    } else if ((isSol ? solMatch : txMatch)) {
      tx = isSol ? solMatch[0] : txMatch[0];
      isValid = isSol ? true : validateEvmTxHash(tx);
    }

    if (isValid) {
      setUserState(userId, 'waiting_desc', { ...state.data, destTx: tx || null });
      responseText = `✅ *Destination TX ${tx ? 'captured' : 'skipped'}.*\n\n` +
                     `📝 *Next: Describe the Issue*\n\n` +
                     `*Please include:*\n` +
                     `• What went wrong? (e.g., "page not found")\n` +
                     `• Amount involved\n` +
                     `• Exact error message\n` +
                     `• Destination wallet if different\n\n` +
                     `Reply with description:`;
    } else {
      responseText = `⚠️ *Invalid TX format for ${chain}.* Type *skip* if unknown.\n\nTry again or skip:`;
    }
    await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }));
    return;
  }

  // Step: waiting_desc
  if (state.state === 'waiting_desc') {
    const desc = text || '_No description provided_';
    const solutions = suggestSolutions(desc, state.data.category);
    setUserState(userId, 'waiting_attach', { ...state.data, desc });
    responseText = `📝 *Description noted.*\n\n` +
                   `*Suggested Solutions:*\n${solutions}\n\n` +
                   `📎 *Next: Attach Proof (Optional)*\n\n` +
                   `Send screenshots/videos (e.g., error screens) or type *skip* to submit.\n\n` +
                   `(Add more later via "Add More Info".)`;
    await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_attach' }]] } }));
    return;
  }

  // Step: waiting_attach
  if (state.state === 'waiting_attach') {
    const data = { ...state.data };
    let attachments = data.attachments || [];

    if (msg.photo) {
      attachments.push({ type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id });
    } else if (msg.video) {
      attachments.push({ type: 'video', fileId: msg.video.file_id });
    } else if (msg.document) {
      attachments.push({ type: 'document', fileId: msg.document.file_id });
    } else if (lowerText === 'skip') {
      await buildAndSendReport(userId, data, attachments, chatId);
      resetUserState(userId);
      return;
    } else {
      data.desc += `\n\nAdditional: ${text}`;
      setUserState(userId, 'waiting_attach', data);
      responseText = `➕ *Added to description.* Send attachments or type *skip* to submit.`;
      await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_attach' }]] } }));
      return;
    }

    setUserState(userId, 'waiting_attach', { ...data, attachments });
    responseText = `📎 *Attachment added.* Send more or type *skip* to submit.`;
    await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_attach' }]] } }));
    return;
  }

  // Fallback
  responseText = `ℹ️ *Noted:* ${text}\n(Added to your report if applicable. Continue or /cancel.)`;
  const updatedData = { ...state.data, desc: (state.data.desc || '') + `\n\nFollow-up: ${text}` };
  setUserState(userId, state.state, updatedData);
  await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown' }));
});

// Report building and sending
async function buildAndSendReport(userId, data, attachments = [], userChatId) {
  try {
    const user = await bot.getChat(userId);
    const categoryLabel = {
      swap_issue: '🟣 BESCSWAP',
      bridge_issue: '🟠 BESCbridge',
      wbesc_issue: '🟡 wBESC Bridge',
      moneyx_issue: '📈 MoneyX (Perps)',
      casino_issue: '🎰 Casino (USDC)',
      other_issue: '🔧 Other'
    }[data.category] || 'Unknown';

    const isBridge = isBridgeCategory(data.category);
    const mainChain = data.chain || (isBridge ? data.sourceChain : 'BSC');
    const descLower = (data.desc || '').toLowerCase();
    let severity = '🟢 Low';
    if (['stuck', 'lost', 'funds', 'hacked', 'urgent', 'exploit', 'drained'].some(kw => descLower.includes(kw))) {
      severity = '🔴 Critical';
    } else if (['error', 'failed', 'timeout', 'slow', 'unexpected', '404', 'not found'].some(kw => descLower.includes(kw))) {
      severity = '🟡 Medium';
    }

    let report = `📌 *[${categoryLabel} ISSUE] – ${mainChain}* ${severity}\n\n` +
                 `👤 **Reporter:** ${user.first_name || 'User'} ${user.last_name ? `(${user.last_name})` : ''}\n` +
                 `🔗 **Username:** ${user.username ? `[@${user.username}](tg://user?id=${userId})` : 'N/A'}\n` +
                 `🆔 **Telegram ID:** \`${userId}\`\n`;

    if (isBridge) {
      report += `🛤️ **Direction:** ${data.sourceChain} → ${data.destChain}\n`;
    }

    if (data.wallet) {
      await validateExplorerUrl(chainExplorers[mainChain].base);
      const baseUrl = explorerCache.get(chainExplorers[mainChain].base) ? chainExplorers[mainChain].base : fallbackExplorer.base;
      const addrPath = chainExplorers[mainChain].addr;
      const walletUrl = `${baseUrl}${addrPath}${data.wallet}`;
      report += `💼 **Wallet:** [${data.wallet.slice(0, 8)}...](${walletUrl})\n`;
    }

    if (data.sourceTx) {
      const sourceChain = data.sourceChain || mainChain;
      await validateExplorerUrl(chainExplorers[sourceChain].base);
      const baseUrl = explorerCache.get(chainExplorers[sourceChain].base) ? chainExplorers[sourceChain].base : fallbackExplorer.base;
      const txPath = chainExplorers[sourceChain].tx;
      const sourceTxUrl = `${baseUrl}${txPath}${data.sourceTx}`;
      report += `🔗 **Source TX (${sourceChain}):** [${data.sourceTx.slice(0, 10)}...](${sourceTxUrl})\n`;
    }

    if (data.destTx) {
      const destChain = data.destChain;
      await validateExplorerUrl(chainExplorers[destChain].base);
      const baseUrl = explorerCache.get(chainExplorers[destChain].base) ? chainExplorers[destChain].base : fallbackExplorer.base;
      const txPath = chainExplorers[destChain].tx;
      const destTxUrl = `${baseUrl}${txPath}${data.destTx}`;
      report += `🔗 **Dest TX (${destChain}):** [${data.destTx.slice(0, 10)}...](${destTxUrl})\n`;
    }

    report += `📝 **Description:**\n\`\`\`${data.desc || '_No description provided_'}\`\`\`\n\n` +
              `📎 **Attachments:** ${attachments.length}\n` +
              `📅 **Submitted:** ${formatDateUTC()}\n\n` +
              `*Suggested Solutions:*\n${suggestSolutions(data.desc || '', data.category)}`;

    let completeness = '✅ Complete';
    if (!data.wallet) completeness = '⚠️ MISSING WALLET';
    if (!data.sourceTx) completeness = '⚠️ MISSING SOURCE TX';
    if (isBridge && !data.destTx) completeness += ' (Dest TX optional)';
    if (!data.wallet && !data.sourceTx) completeness = '🚨 INCOMPLETE - NEEDS FOLLOWUP';
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
        const sentMessage = await limiter.schedule(() => sendMethod(REPORT_CHANNEL_ID, firstAtt.fileId, {
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
          const sendAttMethod = att.type === 'photo' ? bot.sendPhoto : att.type === 'video' ? bot.sendVideo : bot.sendDocument;
          await limiter.schedule(() => sendAttMethod(REPORT_CHANNEL_ID, att.fileId));
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
          inline_keyboard: [[{ text: 'View Report', url: `https://t.me/c/${REPORT_CHANNEL_ID.slice(4)}/${sentMediaGroupId || ''}` }]]
        }
      }));
    }

    const userReview = `✅ *Report Submitted!*\n\n` +
                       `${categoryLabel} – ${mainChain} ${severity}\n` +
                       `${isBridge ? `(${data.sourceChain} → ${data.destChain}) ` : ''}\n` +
                       `${completeness}\n\n` +
                       `Wallet: \`${data.wallet?.slice(0, 10) || 'N/A'}...\`\n` +
                       `Source TX: \`${data.sourceTx?.slice(0, 10) || 'N/A'}...\`\n` +
                       `Dest TX: \`${data.destTx?.slice(0, 10) || 'N/A'}...\`\n\n` +
                       `*Suggested Solutions:*\n${suggestSolutions(data.desc || '', data.category)}\n\n` +
                       `Team will review within 24h. Updates via DM or @BESCLLC.`;
    await limiter.schedule(() => bot.sendMessage(userChatId, userReview, { parse_mode: 'Markdown' }));

    const userButtons = [];
    if (data.sourceTx) {
      const sourceChain = data.sourceChain || mainChain;
      const baseUrl = explorerCache.get(chainExplorers[sourceChain].base) ? chainExplorers[sourceChain].base : fallbackExplorer.base;
      const txPath = chainExplorers[sourceChain].tx;
      userButtons.push([{ text: `🔍 View Source TX (${sourceChain})`, url: `${baseUrl}${txPath}${data.sourceTx}` }]);
    }
    if (data.destTx) {
      const destChain = data.destChain;
      const baseUrl = explorerCache.get(chainExplorers[destChain].base) ? chainExplorers[destChain].base : fallbackExplorer.base;
      const txPath = chainExplorers[destChain].tx;
      userButtons.push([{ text: `🔍 View Dest TX (${destChain})`, url: `${baseUrl}${txPath}${data.destTx}` }]);
    }
    userButtons.push(
      [{ text: '📎 Add More Info', callback_data: 'add_more' }],
      [{ text: '❓ Status?', callback_data: 'status' }]
    );
    await limiter.schedule(() => bot.sendMessage(userChatId, '💡 *Quick Actions:*', {
      reply_markup: { inline_keyboard: userButtons }
    }));

  } catch (err) {
    logger.error(`Report send failed for user ${userId}: ${err.message}`, { data, attachments });
    await limiter.schedule(() => bot.sendMessage(userChatId,
      '⚠️ Submission error—please /start again or contact @BESCLLC on X.',
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
