require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');
const axios = require('axios');
const Bottleneck = require('bottleneck');

const BOT_NAME = 'BESC ECOSYSTEM REPORT BOT';
const BOT_VERSION = '2.0.0';
const SUPPORT_HANDLE = '@BESCLLC';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'besc-ecosystem-report-bot', version: BOT_VERSION },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console()
  ]
});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const token = process.env.BOT_TOKEN;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!token || !REPORT_CHANNEL_ID) {
  logger.error('Missing BOT_TOKEN or REPORT_CHANNEL_ID in environment (.env)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Rate limiter for Telegram API
// ---------------------------------------------------------------------------
const limiter = new Bottleneck({
  minTime: 1000 / 30, // ~30 req/s
  maxConcurrent: 1
});

const bot = new TelegramBot(token, { polling: true });

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------
const userStates = new Map();
const cooldowns = new Map();
const reportQueue = new Map();
const explorerCache = new Map();

// Lightweight in-memory metrics for tier-1 reporting/observability
const metrics = {
  startedAt: Date.now(),
  reportsSubmitted: 0,
  reportsResolved: 0,
  reportsReopened: 0,
  byCategory: {},
  byChain: {},
  bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }
};

function bump(obj, key) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + 1;
}

// ---------------------------------------------------------------------------
// Chain definitions
// ---------------------------------------------------------------------------
const CHAIN_TYPE = {
  EVM: 'evm',
  SOLANA: 'solana',
  XRP: 'xrp'
};

// Per-chain metadata: explorer + native validation type + friendly label
const chains = {
  BSC: { label: 'BNB Smart Chain', type: CHAIN_TYPE.EVM, base: 'https://bscscan.com', tx: '/tx/', addr: '/address/' },
  ETH: { label: 'Ethereum', type: CHAIN_TYPE.EVM, base: 'https://etherscan.io', tx: '/tx/', addr: '/address/' },
  POLYGON: { label: 'Polygon', type: CHAIN_TYPE.EVM, base: 'https://polygonscan.com', tx: '/tx/', addr: '/address/' },
  ARBITRUM: { label: 'Arbitrum One', type: CHAIN_TYPE.EVM, base: 'https://arbiscan.io', tx: '/tx/', addr: '/address/' },
  AVALANCHE: { label: 'Avalanche C-Chain', type: CHAIN_TYPE.EVM, base: 'https://snowtrace.io', tx: '/tx/', addr: '/address/' },
  OPTIMISM: { label: 'Optimism', type: CHAIN_TYPE.EVM, base: 'https://optimistic.etherscan.io', tx: '/tx/', addr: '/address/' },
  BASE: { label: 'Base', type: CHAIN_TYPE.EVM, base: 'https://basescan.org', tx: '/tx/', addr: '/address/' },
  BESC: { label: 'BESC Hyperchain', type: CHAIN_TYPE.EVM, base: 'https://explorer.beschyperchain.com', tx: '/tx/', addr: '/address/' },
  SOLANA: { label: 'Solana', type: CHAIN_TYPE.SOLANA, base: 'https://solscan.io', tx: '/tx/', addr: '/account/' },
  XRP: { label: 'XRP Ledger', type: CHAIN_TYPE.XRP, base: 'https://xrpscan.com', tx: '/tx/', addr: '/account/' }
};

// Backwards-compatible alias used in older code paths
const chainExplorers = chains;

const fallbackExplorer = { base: 'https://blockscan.com', tx: '/tx/', addr: '/address/' };

const chainLabel = (c) => (chains[c] ? `${c} (${chains[c].label})` : c);
const chainType = (c) => (chains[c] ? chains[c].type : CHAIN_TYPE.EVM);

// Native gas/asset per chain — used by the wBESC bridge to describe the
// wrapped-asset mapping (e.g. BNB on BSC -> WBNB on BESC Hyperchain).
const nativeAsset = {
  BSC: 'BNB',
  ETH: 'ETH',
  POLYGON: 'POL',
  ARBITRUM: 'ETH',
  AVALANCHE: 'AVAX',
  OPTIMISM: 'ETH',
  BASE: 'ETH',
  SOLANA: 'SOL',
  XRP: 'XRP',
  BESC: 'BESC'
};

const nativeAssetOf = (c) => nativeAsset[c] || c;
const wrappedAssetOf = (c) => 'W' + nativeAssetOf(c);

// Human-readable asset flow for the wBESC bridge. Returns null for non-wBESC.
// to BESC:   <NATIVE> on <ext> -> W<NATIVE> on BESC Hyperchain
// from BESC: W<NATIVE> on BESC Hyperchain -> <NATIVE> on <ext>
function assetRouteText(data) {
  if (data.category !== 'wbesc_issue') return null;
  const ext = data.direction === 'to BESC' ? data.sourceChain : data.destChain;
  if (!ext || ext === 'BESC') return null;
  const nat = nativeAssetOf(ext);
  const wrap = wrappedAssetOf(ext);
  return data.direction === 'to BESC'
    ? `${nat} on ${chainLabel(ext)} → ${wrap} on BESC Hyperchain`
    : `${wrap} on BESC Hyperchain → ${nat} on ${chainLabel(ext)}`;
}

// ---------------------------------------------------------------------------
// Supported chains per category
// ---------------------------------------------------------------------------
// Bridge now fully supports XRP <-> BESC and SOLANA <-> BESC (bi-directional),
// alongside all EVM routes.
const supportedChains = {
  swap_issue: ['BSC', 'ETH', 'BESC'],
  other_issue: Object.keys(chains),
  bridge_issue: ['XRP', 'SOLANA', 'ETH', 'BSC', 'POLYGON', 'ARBITRUM', 'AVALANCHE', 'OPTIMISM', 'BASE'],
  wbesc_issue: ['XRP', 'SOLANA', 'ETH', 'BSC', 'POLYGON', 'ARBITRUM', 'AVALANCHE', 'OPTIMISM', 'BASE'],
  moneyx_issue: ['BSC', 'ETH', 'BESC'],
  casino_issue: ['SOLANA', 'BSC', 'ETH']
};

const CATEGORY_LABELS = {
  swap_issue: '🟣 BESCswap',
  bridge_issue: '🟠 BESC Bridge',
  wbesc_issue: '🟡 wBESC Bridge',
  moneyx_issue: '📈 MoneyX (Perps)',
  casino_issue: '🎰 BESC Casino (USDC)',
  other_issue: '🔧 Other / General'
};

// ---------------------------------------------------------------------------
// Validation patterns + helpers (chain-aware)
// ---------------------------------------------------------------------------
const RE = {
  evmAddr: /\b0x[a-fA-F0-9]{40}\b/,
  evmHash: /\b0x[a-fA-F0-9]{64}\b/,
  solBase58: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/,
  solSig: /\b[1-9A-HJ-NP-Za-km-z]{43,88}\b/,
  xrpAddr: /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/,
  xrpHash: /\b[A-Fa-f0-9]{64}\b/
};

function validateWallet(addr, chain) {
  if (!addr) return false;
  switch (chainType(chain)) {
    case CHAIN_TYPE.SOLANA: return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
    case CHAIN_TYPE.XRP: return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr);
    default: return /^0x[a-fA-F0-9]{40}$/.test(addr);
  }
}

function validateTx(txHash, chain) {
  if (!txHash) return false;
  switch (chainType(chain)) {
    case CHAIN_TYPE.SOLANA: return /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(txHash);
    case CHAIN_TYPE.XRP: return /^[A-Fa-f0-9]{64}$/.test(txHash);
    default: return /^0x[a-fA-F0-9]{64}$/.test(txHash);
  }
}

// Pull the most likely wallet/tx token out of free-form text for a given chain
function extractWallet(text, chain) {
  if (!text) return null;
  let m;
  switch (chainType(chain)) {
    case CHAIN_TYPE.SOLANA: m = text.match(RE.solBase58); break;
    case CHAIN_TYPE.XRP: m = text.match(RE.xrpAddr); break;
    default: m = text.match(RE.evmAddr); break;
  }
  return m ? m[0] : null;
}

function extractTx(text, chain) {
  if (!text) return null;
  let m;
  switch (chainType(chain)) {
    case CHAIN_TYPE.SOLANA: m = text.match(RE.solSig); break;
    case CHAIN_TYPE.XRP: m = text.match(RE.xrpHash); break;
    default: m = text.match(RE.evmHash); break;
  }
  return m ? m[0] : null;
}

function walletExample(chain) {
  switch (chainType(chain)) {
    case CHAIN_TYPE.SOLANA: return '`9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`';
    case CHAIN_TYPE.XRP: return '`rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe`';
    default: return '`0x1234abcd...` (42 chars)';
  }
}

function txExample(chain) {
  switch (chainType(chain)) {
    case CHAIN_TYPE.SOLANA: return 'Base58 signature, e.g. `5EyP3Mgv...`';
    case CHAIN_TYPE.XRP: return '64 hex chars (uppercase), e.g. `A1B2C3...`';
    default: return '`0x...` (66 chars)';
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function formatDateUTC(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
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
      [
        { text: '✅ Resolve', callback_data: `resolve_${userId}` },
        { text: '🔄 Reopen', callback_data: `reopen_${userId}` }
      ],
      [
        { text: '👤 Contact User', url: `tg://user?id=${userId}` },
        { text: '📊 Stats', callback_data: 'admin_stats' }
      ]
    ]
  };
}

async function validateExplorerUrl(url) {
  if (explorerCache.has(url)) return explorerCache.get(url);
  try {
    const response = await axios.head(url, {
      timeout: 5000,
      headers: { 'User-Agent': `BESCEcosystemReportBot/${BOT_VERSION} (Node.js)` }
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

function explorerBase(chain) {
  const def = chains[chain] || fallbackExplorer;
  return explorerCache.get(def.base) === false ? fallbackExplorer.base : def.base;
}

function txLink(chain, hash) {
  const def = chains[chain] || fallbackExplorer;
  return `${explorerBase(chain)}${def.tx}${hash}`;
}

function addrLink(chain, addr) {
  const def = chains[chain] || fallbackExplorer;
  return `${explorerBase(chain)}${def.addr}${addr}`;
}

function isBridgeCategory(category) {
  return category === 'bridge_issue' || category === 'wbesc_issue';
}

// ---------------------------------------------------------------------------
// Severity triage
// ---------------------------------------------------------------------------
const SEVERITY = {
  CRITICAL: '🔴 Critical',
  HIGH: '🟠 High',
  MEDIUM: '🟡 Medium',
  LOW: '🟢 Low'
};

function classifySeverity(desc = '') {
  const d = desc.toLowerCase();
  if (['hacked', 'exploit', 'drained', 'stolen', 'lost funds', 'lost my', 'phish', 'scam'].some(k => d.includes(k))) {
    return SEVERITY.CRITICAL;
  }
  if (['stuck', 'pending', 'missing', 'not arrived', "didn't arrive", 'did not arrive', 'funds', 'no funds', 'urgent', 'reverted'].some(k => d.includes(k))) {
    return SEVERITY.HIGH;
  }
  if (['error', 'failed', 'timeout', 'slow', 'unexpected', '404', 'not found', 'rejected', 'cannot', "can't"].some(k => d.includes(k))) {
    return SEVERITY.MEDIUM;
  }
  return SEVERITY.LOW;
}

function severityKey(sev) {
  if (sev === SEVERITY.CRITICAL) return 'critical';
  if (sev === SEVERITY.HIGH) return 'high';
  if (sev === SEVERITY.MEDIUM) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Auto-suggest solutions (chain + category aware)
// ---------------------------------------------------------------------------
function suggestSolutions(desc, category, data = {}) {
  const d = (desc || '').toLowerCase();
  const solutions = [];
  const sourceChain = data.sourceChain || data.chain;
  const destChain = data.destChain;
  const touchesXrp = sourceChain === 'XRP' || destChain === 'XRP';
  const touchesSol = sourceChain === 'SOLANA' || destChain === 'SOLANA';

  if (d.includes('unexpected error')) {
    solutions.push('⚠️ "Unexpected error": refresh the page, clear browser cache, switch browsers, and reconnect your wallet. Disable conflicting wallet extensions.');
  }
  if (d.includes('page not found') || d.includes('404')) {
    solutions.push(`🛑 "Page not found": verify the official URL (e.g. bescbridge.com) and check ${SUPPORT_HANDLE} on X for maintenance notices.`);
  }
  if (d.includes('approve') || d.includes('approval') || d.includes('allowance')) {
    solutions.push('🔑 Approval/allowance issue: confirm the token approval transaction succeeded on the source chain before bridging/swapping. Re-approve if it was rejected.');
  }
  if (d.includes('gas') || d.includes('fee')) {
    solutions.push('⛽ Gas/fee issue: ensure you hold enough native gas token on the source chain (BNB/ETH/etc.). Increase gas and retry.');
  }

  if (isBridgeCategory(category)) {
    if (d.includes('stuck') || d.includes('pending')) {
      solutions.push('⏳ Bridge transaction stuck/pending: confirm the source TX is finalized on its explorer, then allow 5–30 min for cross-chain relay. Always include BOTH source and destination TX hashes.');
    }
    if (d.includes('not arrived') || d.includes('missing') || d.includes("didn't arrive")) {
      solutions.push('💸 Funds not arrived: double-check the destination address/network. Cross-chain settlement can take 5–30 min. Provide both TX hashes for tracing.');
    }
    if (touchesXrp) {
      solutions.push('🟦 XRP Ledger note: XRP transfers may require a **Destination Tag**. If a tag was needed and omitted/incorrect, include it so the team can trace the deposit. Verify the source TX on xrpscan.com.');
    }
    if (touchesSol) {
      solutions.push('🟪 Solana note: confirm the transaction is finalized (not just confirmed) on Solscan, and that the correct SPL token account/ATA was used.');
    }
  }

  if (category === 'swap_issue' && (d.includes('slippage') || d.includes('price') || d.includes('revert'))) {
    solutions.push('🔁 Swap reverted: increase slippage tolerance slightly, refresh quotes, and ensure liquidity exists for the pair.');
  }
  if (category === 'moneyx_issue' && (d.includes('trade') || d.includes('perp') || d.includes('margin') || d.includes('leverage') || d.includes('liquidat'))) {
    solutions.push('📈 MoneyX (Perps): verify margin balance, leverage, and that you hold sufficient collateral for fees/funding. Note your position size and pair.');
  }
  if (category === 'casino_issue' && (d.includes('usdc') || d.includes('balance') || d.includes('deposit') || d.includes('withdraw'))) {
    solutions.push('🎰 Casino (USDC): confirm USDC approval on the correct chain (Solana/BSC/ETH) and that deposit/withdraw used the matching network.');
  }

  return solutions.length > 0
    ? solutions.join('\n')
    : 'ℹ️ No automated match. Please attach screenshots and include exact error text, amount, and timestamp so the team can resolve quickly.';
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
bot.onText(/^\/stats/, async (msg) => {
  if (!isAdmin(msg.chat.id)) {
    return limiter.schedule(() => bot.sendMessage(msg.chat.id, '❌ Admin-only command.', { parse_mode: 'Markdown' }));
  }
  await limiter.schedule(() => bot.sendMessage(msg.chat.id, buildStatsText(), { parse_mode: 'Markdown' }));
});

function buildStatsText() {
  const inProgress = Array.from(userStates.values()).filter(s => s.state !== 'idle').length;
  const activeUsers = userStates.size;
  const uptime = process.uptime();
  const uptimeStr = `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

  const catLines = Object.entries(metrics.byCategory)
    .map(([k, v]) => `   • ${CATEGORY_LABELS[k] || k}: ${v}`)
    .join('\n') || '   • (none yet)';
  const chainLines = Object.entries(metrics.byChain)
    .map(([k, v]) => `   • ${k}: ${v}`)
    .join('\n') || '   • (none yet)';

  return `📊 *${BOT_NAME} — Statistics*\n\n` +
    `🟢 *Live*\n` +
    `   • Active users: ${activeUsers}\n` +
    `   • Reports in progress: ${inProgress}\n` +
    `   • Uptime: ${uptimeStr}\n` +
    `   • Version: v${BOT_VERSION}\n\n` +
    `📈 *Totals*\n` +
    `   • Submitted: ${metrics.reportsSubmitted}\n` +
    `   • Resolved: ${metrics.reportsResolved}\n` +
    `   • Reopened: ${metrics.reportsReopened}\n\n` +
    `🚦 *Severity*\n` +
    `   • 🔴 Critical: ${metrics.bySeverity.critical}\n` +
    `   • 🟠 High: ${metrics.bySeverity.high}\n` +
    `   • 🟡 Medium: ${metrics.bySeverity.medium}\n` +
    `   • 🟢 Low: ${metrics.bySeverity.low}\n\n` +
    `🗂️ *By category*\n${catLines}\n\n` +
    `🔗 *By chain*\n${chainLines}`;
}

bot.onText(/^\/help/, async (msg) => {
  const helpText = `📖 *${BOT_NAME} — How to Report*\n\n` +
    `This bot guides you through a precise, step-by-step report so the team can resolve your issue fast.\n\n` +
    `1️⃣ */start* → choose the affected product (Swap, Bridge, wBESC, MoneyX, Casino, Other)\n` +
    `2️⃣ *Bridges:* pick direction (to/from BESC Hyperchain) and the external chain\n` +
    `3️⃣ *Others:* pick the chain\n` +
    `4️⃣ *Wallet:* paste your wallet address\n` +
    `5️⃣ *Source TX:* paste the source transaction hash\n` +
    `6️⃣ *Dest TX:* paste the destination TX (bridges only, optional)\n` +
    `7️⃣ *Details:* describe the issue (error text, amount, timestamp)\n` +
    `8️⃣ *Proof:* attach screenshots/videos or type *skip*\n` +
    `9️⃣ *Submit* ✅\n\n` +
    `🌉 *BESC Bridge routes*\n` +
    `   • XRP ⇄ BESC Hyperchain\n` +
    `   • Solana ⇄ BESC Hyperchain\n` +
    `   • ETH / BSC / Polygon / Arbitrum / Avalanche / Optimism / Base ⇄ BESC\n\n` +
    `🟡 *wBESC Bridge (wrapped assets)* — both directions on every chain\n` +
    `   • BNB (BSC) ⇄ WBNB on BESC Hyperchain\n` +
    `   • ETH (Ethereum) ⇄ WETH on BESC Hyperchain\n` +
    `   • XRP ⇄ WXRP, SOL ⇄ WSOL, and all other chains\n\n` +
    `🟢 *Pro tips*\n` +
    `   • Include exact errors, amounts, and TX hashes\n` +
    `   • XRP: include the **Destination Tag** if one was used\n` +
    `   • Solana: ensure the TX is *finalized* before reporting\n` +
    `   • Use /cancel anytime to restart\n\n` +
    `🔒 *Privacy:* your report is shared only with the BESC team.\n` +
    `Questions? Contact ${SUPPORT_HANDLE} on X.`;
  await limiter.schedule(() => bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' }));
});

bot.onText(/^\/cancel/, async (msg) => {
  resetUserState(msg.from.id);
  await limiter.schedule(() => bot.sendMessage(msg.chat.id, `🔄 *Report cancelled.* Start over with /start or /help.`, { parse_mode: 'Markdown' }));
});

async function sendWelcome(chatId, userId) {
  resetUserState(userId);
  setUserState(userId, 'waiting_category', {});
  await limiter.schedule(() => bot.sendMessage(chatId,
    `🛰️ *Welcome to the ${BOT_NAME}* 🛰️\n\n` +
    `The official end-to-end issue desk for the entire BESC ecosystem — Swap, Bridge, wBESC, MoneyX, Casino and more.\n\n` +
    `👇 *Step 1 — Select the affected product:*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🟣 BESCswap', callback_data: 'swap_issue' }],
          [{ text: '🟠 BESC Bridge', callback_data: 'bridge_issue' }],
          [{ text: '🟡 wBESC Bridge', callback_data: 'wbesc_issue' }],
          [{ text: '📈 MoneyX (Perps)', callback_data: 'moneyx_issue' }],
          [{ text: '🎰 BESC Casino (USDC)', callback_data: 'casino_issue' }],
          [{ text: '🔧 Other / General', callback_data: 'other_issue' }],
          [{ text: '❓ Help', callback_data: 'help' }]
        ]
      }
    }
  ));
}

bot.onText(/^\/start/, async (msg) => sendWelcome(msg.chat.id, msg.from.id));
bot.onText(/^\/report/, async (msg) => sendWelcome(msg.chat.id, msg.from.id));

// ---------------------------------------------------------------------------
// Callback handler
// ---------------------------------------------------------------------------
bot.on('callback_query', async (cbq) => {
  const userId = cbq.from.id;
  const chatId = cbq.message.chat.id;
  const state = getUserState(userId);
  const data = cbq.data;

  try {
    if (data === 'help') {
      await limiter.schedule(() => bot.sendMessage(chatId, 'ℹ️ Use /help for the full reporting guide.', { parse_mode: 'Markdown' }));
    } else if (/^resolve_/.test(data)) {
      if (!isAdmin(chatId)) { await bot.answerCallbackQuery(cbq.id, { text: '❌ Admin only!' }); return; }
      const resolveUserId = data.split('_')[1];
      metrics.reportsResolved += 1;
      await limiter.schedule(() => bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId, message_id: cbq.message.message_id
      }));
      await limiter.schedule(() => bot.sendMessage(chatId, `✅ *Report RESOLVED* for user \`${resolveUserId}\`.`, { parse_mode: 'Markdown' }));
      try {
        await limiter.schedule(() => bot.sendMessage(resolveUserId,
          `🎉 *Good news!* Your report to the ${BOT_NAME} has been resolved.\nReply here or contact ${SUPPORT_HANDLE} on X if you need anything else.`,
          { parse_mode: 'Markdown' }
        ));
      } catch (e) {
        logger.error(`Failed to notify user ${resolveUserId}: ${e.message}`);
      }
    } else if (/^reopen_/.test(data)) {
      if (!isAdmin(chatId)) { await bot.answerCallbackQuery(cbq.id, { text: '❌ Admin only!' }); return; }
      const reopenUserId = data.split('_')[1];
      metrics.reportsReopened += 1;
      await limiter.schedule(() => bot.editMessageReplyMarkup(getAdminButtons(reopenUserId), {
        chat_id: chatId, message_id: cbq.message.message_id
      }));
      await limiter.schedule(() => bot.sendMessage(chatId, `🔄 *Report REOPENED* for user \`${reopenUserId}\`.`, { parse_mode: 'Markdown' }));
    } else if (data === 'admin_stats') {
      if (!isAdmin(chatId)) { await bot.answerCallbackQuery(cbq.id, { text: '❌ Admin only!' }); return; }
      await limiter.schedule(() => bot.sendMessage(chatId, buildStatsText(), { parse_mode: 'Markdown' }));
    } else if (['swap_issue', 'bridge_issue', 'wbesc_issue', 'moneyx_issue', 'casino_issue', 'other_issue'].includes(data)) {
      const categoryLabel = CATEGORY_LABELS[data];
      setUserState(userId, isBridgeCategory(data) ? 'waiting_direction' : 'waiting_chain', { category: data });
      if (isBridgeCategory(data)) {
        await limiter.schedule(() => bot.editMessageText(`${categoryLabel} *selected.*\n\n👇 *Step 2 — Bridge direction:*`, {
          chat_id: chatId,
          message_id: cbq.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '➡️ Into BESC Hyperchain', callback_data: 'direction_to' }],
              [{ text: '⬅️ Out of BESC Hyperchain', callback_data: 'direction_from' }]
            ]
          }
        }));
      } else {
        const keyboard = supportedChains[data].map(c => [{ text: chainLabel(c), callback_data: `chain_${c}` }]);
        await limiter.schedule(() => bot.editMessageText(`${categoryLabel} *selected.*\n\n👇 *Step 2 — Select chain:*`, {
          chat_id: chatId,
          message_id: cbq.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }));
      }
    } else if (data.startsWith('direction_')) {
      const direction = data === 'direction_to' ? 'to BESC' : 'from BESC';
      setUserState(userId, 'waiting_external_chain', { ...state.data, direction });
      const keyboard = supportedChains[state.data.category].map(c => [{ text: chainLabel(c), callback_data: `extchain_${c}` }]);
      const dirLabel = direction === 'to BESC' ? 'External chain ➡️ BESC Hyperchain' : 'BESC Hyperchain ➡️ External chain';
      await limiter.schedule(() => bot.editMessageText(`Direction: *${dirLabel}*\n\n👇 *Step 3 — Select the external chain:*`, {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }));
    } else if (data.startsWith('extchain_')) {
      const extChain = data.split('_')[1];
      let sourceChain, destChain;
      if (state.data.direction === 'to BESC') {
        sourceChain = extChain; destChain = 'BESC';
      } else {
        sourceChain = 'BESC'; destChain = extChain;
      }
      const newData = { ...state.data, sourceChain, destChain };
      const assetRoute = assetRouteText(newData);
      setUserState(userId, 'waiting_wallet', newData);
      await limiter.schedule(() => bot.editMessageText(
        `Route: *${chainLabel(sourceChain)} → ${chainLabel(destChain)}*\n` +
        (assetRoute ? `Asset: *${assetRoute}*\n` : '') +
        `\n👤 *Step 4 — Your wallet address*\n\n` +
        `Format for ${chainLabel(sourceChain)}: ${walletExample(sourceChain)}\n\nReply with your address:`,
        { chat_id: chatId, message_id: cbq.message.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
      ));
    } else if (data.startsWith('chain_')) {
      const chain = data.split('_')[1];
      setUserState(userId, 'waiting_wallet', { ...state.data, chain });
      await limiter.schedule(() => bot.editMessageText(
        `Chain: *${chainLabel(chain)}*\n\n👤 *Step 3 — Your wallet address*\n\n` +
        `Format: ${walletExample(chain)}\n\nReply with your address:`,
        { chat_id: chatId, message_id: cbq.message.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
      ));
    } else if (data === 'add_more') {
      setUserState(userId, 'waiting_desc', state.data);
      await limiter.schedule(() => bot.sendMessage(chatId, '➕ *Adding to your report.* Reply with the additional info:', { parse_mode: 'Markdown' }));
    } else if (data === 'status') {
      await limiter.schedule(() => bot.sendMessage(chatId,
        `⏳ *Status*\nYour report is in the BESC team queue.\nExpect a response within 24h via DM, or follow ${SUPPORT_HANDLE} on X.\n\n💡 Use "Add More Info" to update it.`,
        { parse_mode: 'Markdown' }
      ));
    } else if (data === 'skip_tx' || data === 'skip_attach') {
      if (data === 'skip_tx') {
        if (isBridgeCategory(state.data.category) && state.state !== 'waiting_dest_tx') {
          // skipping source tx on a bridge -> go to dest tx
          setUserState(userId, 'waiting_dest_tx', { ...state.data, sourceTx: null });
          await limiter.schedule(() => bot.sendMessage(chatId,
            `✅ *Source TX skipped.*\n\n🔗 *Next — Destination TX hash for ${chainLabel(state.data.destChain)} (if known):*\n\nReply with the dest TX or type *skip*:`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }
          ));
        } else {
          // skipping (source or dest) tx -> go to description
          const patch = state.state === 'waiting_dest_tx' ? { destTx: null } : { sourceTx: null };
          setUserState(userId, 'waiting_desc', { ...state.data, ...patch });
          await limiter.schedule(() => bot.sendMessage(chatId, descPrompt('✅ *TX skipped.*'), { parse_mode: 'Markdown' }));
        }
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

function descPrompt(prefix) {
  return `${prefix}\n\n📝 *Next — Describe the issue*\n\n*Please include:*\n` +
    `• What went wrong (e.g. "unexpected error")\n` +
    `• Amount involved\n` +
    `• Exact error message\n` +
    `• Approx. time it happened\n` +
    `• Bridges: destination wallet / XRP destination tag if relevant\n\n` +
    `Reply with your description:`;
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------
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
    return limiter.schedule(() => bot.sendMessage(chatId, '⏳ Slow down! Please wait a few seconds before sending again.', { parse_mode: 'Markdown' }));
  }
  cooldowns.set(userId, Date.now());

  const state = getUserState(userId);
  const text = (msg.text || '').trim();
  const lowerText = text.toLowerCase();

  // Auto-start for pasted TX/address
  if (state.state === 'idle' && text && (RE.evmHash.test(text) || RE.evmAddr.test(text) || RE.xrpAddr.test(text) || RE.solBase58.test(text))) {
    setUserState(userId, 'waiting_category', { category: 'other_issue' });
    await limiter.schedule(() => bot.sendMessage(chatId,
      `🔍 *Detected on-chain data.*\nLet's file a report — start by choosing the affected product:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🟣 BESCswap', callback_data: 'swap_issue' }, { text: '🟠 BESC Bridge', callback_data: 'bridge_issue' }],
            [{ text: '📈 MoneyX', callback_data: 'moneyx_issue' }, { text: '🎰 Casino', callback_data: 'casino_issue' }],
            [{ text: '🔧 Other', callback_data: 'other_issue' }]
          ]
        }
      }
    ));
    return;
  }

  if (state.state === 'waiting_category' && !msg.text) {
    return limiter.schedule(() => bot.sendMessage(chatId, `🚨 Start your report with /start`, { parse_mode: 'Markdown' }));
  }

  // Step: waiting_wallet
  if (state.state === 'waiting_wallet') {
    const chain = state.data.sourceChain || state.data.chain;
    const wallet = extractWallet(text, chain);
    let responseText;
    if (wallet && validateWallet(wallet, chain)) {
      setUserState(userId, 'waiting_source_tx', { ...state.data, wallet });
      responseText = `✅ *Wallet validated:* \`${wallet.slice(0, 10)}...\`\n\n` +
        `🔗 *Next — Source transaction hash for ${chainLabel(chain)}:*\n` +
        `Format: ${txExample(chain)}\n\nReply with the TX or type *skip* if unknown:`;
    } else {
      responseText = `⚠️ *That doesn't look like a valid ${chainLabel(chain)} address.*\n\n` +
        `Expected format: ${walletExample(chain)}\n\nPlease try again:`;
    }
    await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }));
    return;
  }

  // Step: waiting_source_tx
  if (state.state === 'waiting_source_tx') {
    const chain = state.data.sourceChain || state.data.chain;
    let tx = '';
    let isValid = false;
    if (lowerText === 'skip') {
      isValid = true;
    } else {
      tx = extractTx(text, chain) || '';
      isValid = validateTx(tx, chain);
    }

    if (isValid) {
      const nextState = isBridgeCategory(state.data.category) ? 'waiting_dest_tx' : 'waiting_desc';
      setUserState(userId, nextState, { ...state.data, sourceTx: tx || null });
      let responseText = `✅ *Source TX ${tx ? 'captured' : 'skipped'}:* \`${tx ? tx.slice(0, 10) + '...' : 'N/A'}\`\n\n`;
      if (nextState === 'waiting_dest_tx') {
        responseText += `🔗 *Next — Destination TX hash for ${chainLabel(state.data.destChain)} (if known):*\n\nReply with the dest TX or type *skip*:`;
        await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }));
      } else {
        await limiter.schedule(() => bot.sendMessage(chatId, descPrompt(responseText.trim()), { parse_mode: 'Markdown' }));
      }
    } else {
      const responseText = `⚠️ *That doesn't look like a valid ${chainLabel(chain)} TX hash.*\n` +
        `Expected: ${txExample(chain)}\n\nTry again or type *skip*:`;
      await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }));
    }
    return;
  }

  // Step: waiting_dest_tx
  if (state.state === 'waiting_dest_tx') {
    const chain = state.data.destChain;
    let tx = '';
    let isValid = false;
    if (lowerText === 'skip') {
      isValid = true;
    } else {
      tx = extractTx(text, chain) || '';
      isValid = validateTx(tx, chain);
    }

    if (isValid) {
      setUserState(userId, 'waiting_desc', { ...state.data, destTx: tx || null });
      await limiter.schedule(() => bot.sendMessage(chatId, descPrompt(`✅ *Destination TX ${tx ? 'captured' : 'skipped'}.*`), { parse_mode: 'Markdown' }));
    } else {
      const responseText = `⚠️ *That doesn't look like a valid ${chainLabel(chain)} TX hash.*\n` +
        `Expected: ${txExample(chain)}\n\nTry again or type *skip*:`;
      await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'skip_tx' }]] } }));
    }
    return;
  }

  // Step: waiting_desc
  if (state.state === 'waiting_desc') {
    const desc = text || '_No description provided_';
    const solutions = suggestSolutions(desc, state.data.category, state.data);
    setUserState(userId, 'waiting_attach', { ...state.data, desc });
    const responseText = `📝 *Description noted.*\n\n*Suggested next steps:*\n${solutions}\n\n` +
      `📎 *Final step — Attach proof (optional)*\n` +
      `Send screenshots/videos/documents, or type *skip* to submit now.`;
    await limiter.schedule(() => bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip & Submit', callback_data: 'skip_attach' }]] } }));
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
      data.desc = (data.desc || '') + `\n\nAdditional: ${text}`;
      setUserState(userId, 'waiting_attach', data);
      await limiter.schedule(() => bot.sendMessage(chatId, `➕ *Added to description.* Send attachments or type *skip* to submit.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip & Submit', callback_data: 'skip_attach' }]] } }));
      return;
    }

    setUserState(userId, 'waiting_attach', { ...data, attachments });
    await limiter.schedule(() => bot.sendMessage(chatId, `📎 *Attachment added (${attachments.length}).* Send more or type *skip* to submit.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Skip & Submit', callback_data: 'skip_attach' }]] } }));
    return;
  }

  // Fallback
  if (state.state === 'idle') {
    return limiter.schedule(() => bot.sendMessage(chatId, `👋 Welcome to the *${BOT_NAME}*. Use /start to file a report or /help for guidance.`, { parse_mode: 'Markdown' }));
  }
  const updatedData = { ...state.data, desc: (state.data.desc || '') + `\n\nFollow-up: ${text}` };
  setUserState(userId, state.state, updatedData);
  await limiter.schedule(() => bot.sendMessage(chatId, `ℹ️ *Noted.* (Added to your report. Continue the current step or /cancel.)`, { parse_mode: 'Markdown' }));
});

// ---------------------------------------------------------------------------
// Report building and sending
// ---------------------------------------------------------------------------
function generateReportId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `BESC-${t}-${r}`;
}

async function buildAndSendReport(userId, data, attachments = [], userChatId) {
  try {
    const user = await bot.getChat(userId);
    const categoryLabel = CATEGORY_LABELS[data.category] || 'Unknown';
    const isBridge = isBridgeCategory(data.category);
    const mainChain = data.chain || (isBridge ? data.sourceChain : 'BSC');
    const severity = classifySeverity(data.desc || '');
    const reportId = generateReportId();
    const solutions = suggestSolutions(data.desc || '', data.category, data);

    // Validate explorer endpoints we plan to link (cached)
    const chainsToCheck = new Set([mainChain, data.sourceChain, data.destChain, data.chain].filter(Boolean));
    await Promise.all(Array.from(chainsToCheck).map(c => chains[c] ? validateExplorerUrl(chains[c].base) : Promise.resolve()));

    let report = `📌 *${categoryLabel} — ${chainLabel(mainChain)}*  ${severity}\n` +
      `🧾 *Report ID:* \`${reportId}\`\n\n` +
      `👤 *Reporter:* ${user.first_name || 'User'}${user.last_name ? ' ' + user.last_name : ''}\n` +
      `🔗 *Username:* ${user.username ? `[@${user.username}](tg://user?id=${userId})` : 'N/A'}\n` +
      `🆔 *Telegram ID:* \`${userId}\`\n`;

    if (isBridge) {
      report += `🛤️ *Route:* ${chainLabel(data.sourceChain)} → ${chainLabel(data.destChain)}\n`;
      const assetRoute = assetRouteText(data);
      if (assetRoute) report += `🪙 *Asset:* ${assetRoute}\n`;
    }

    if (data.wallet) {
      report += `💼 *Wallet:* [${data.wallet.slice(0, 10)}...](${addrLink(mainChain, data.wallet)})\n`;
    }
    if (data.sourceTx) {
      const sc = data.sourceChain || mainChain;
      report += `🔗 *Source TX (${sc}):* [${data.sourceTx.slice(0, 12)}...](${txLink(sc, data.sourceTx)})\n`;
    }
    if (data.destTx) {
      report += `🔗 *Dest TX (${data.destChain}):* [${data.destTx.slice(0, 12)}...](${txLink(data.destChain, data.destTx)})\n`;
    }

    report += `\n📝 *Description:*\n\`\`\`\n${data.desc || 'No description provided'}\n\`\`\`\n` +
      `📎 *Attachments:* ${attachments.length}\n` +
      `📅 *Submitted:* ${formatDateUTC()}\n\n` +
      `🛠️ *Suggested next steps:*\n${solutions}\n`;

    // Completeness / triage flag
    let completeness = '✅ Complete';
    if (!data.wallet && !data.sourceTx) completeness = '🚨 INCOMPLETE — needs follow-up (no wallet or TX)';
    else if (!data.wallet) completeness = '⚠️ Missing wallet';
    else if (!data.sourceTx) completeness = '⚠️ Missing source TX';
    if (isBridge && !data.destTx && completeness === '✅ Complete') completeness = '✅ Complete (dest TX optional)';
    report += `\n📋 *Completeness:* ${completeness}`;

    // Split for Telegram 4096 limit
    const MAX = 4096;
    const reportMessages = [];
    if (report.length > MAX) {
      let cur = '';
      for (const line of report.split('\n')) {
        if (cur.length + line.length + 1 > MAX) { reportMessages.push(cur); cur = ''; }
        cur += line + '\n';
      }
      if (cur) reportMessages.push(cur);
    } else {
      reportMessages.push(report);
    }

    let firstMessageId = null;
    if (attachments.length > 0) {
      const photoGroup = attachments
        .filter(a => a.type === 'photo')
        .map((a, i) => ({ type: 'photo', media: a.fileId, caption: i === 0 ? reportMessages[0] : undefined, parse_mode: i === 0 ? 'Markdown' : undefined }));

      if (photoGroup.length > 0) {
        const sent = await limiter.schedule(() => bot.sendMediaGroup(REPORT_CHANNEL_ID, photoGroup));
        firstMessageId = sent[0].message_id;
        for (let i = 1; i < reportMessages.length; i++) {
          await limiter.schedule(() => bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
            parse_mode: 'Markdown',
            reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : undefined
          }));
        }
        // If single message + media group, append admin controls
        if (reportMessages.length === 1) {
          await limiter.schedule(() => bot.sendMessage(REPORT_CHANNEL_ID, `🎛️ *Admin controls — ${reportId}*`, { parse_mode: 'Markdown', reply_markup: getAdminButtons(userId) }));
        }
        for (const att of attachments.filter(a => a.type !== 'photo')) {
          if (att.type === 'video') await limiter.schedule(() => bot.sendVideo(REPORT_CHANNEL_ID, att.fileId));
          else if (att.type === 'document') await limiter.schedule(() => bot.sendDocument(REPORT_CHANNEL_ID, att.fileId));
        }
      } else {
        const first = attachments[0];
        const sendFirst = first.type === 'video' ? bot.sendVideo.bind(bot) : bot.sendDocument.bind(bot);
        const sent = await limiter.schedule(() => sendFirst(REPORT_CHANNEL_ID, first.fileId, {
          caption: reportMessages[0],
          parse_mode: 'Markdown',
          reply_markup: reportMessages.length === 1 ? getAdminButtons(userId) : undefined
        }));
        firstMessageId = sent.message_id;
        for (let i = 1; i < reportMessages.length; i++) {
          await limiter.schedule(() => bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
            parse_mode: 'Markdown',
            reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : undefined
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
        const sent = await limiter.schedule(() => bot.sendMessage(REPORT_CHANNEL_ID, reportMessages[i], {
          parse_mode: 'Markdown',
          reply_markup: i === reportMessages.length - 1 ? getAdminButtons(userId) : undefined
        }));
        if (i === 0) firstMessageId = sent.message_id;
      }
    }

    // Metrics
    metrics.reportsSubmitted += 1;
    bump(metrics.byCategory, data.category);
    bump(metrics.byChain, mainChain);
    if (isBridge && data.destChain) bump(metrics.byChain, data.destChain);
    metrics.bySeverity[severityKey(severity)] += 1;

    // Admin alert
    if (ADMIN_CHAT_ID) {
      const alertText = `🔔 *New ${severity === SEVERITY.CRITICAL ? '🚨 CRITICAL ' : ''}report* — ${categoryLabel}\n` +
        `ID: \`${reportId}\` • From: ${user.first_name || userId}`;
      const channelShort = REPORT_CHANNEL_ID.toString().startsWith('-100') ? REPORT_CHANNEL_ID.toString().slice(4) : null;
      const replyMarkup = channelShort && firstMessageId
        ? { inline_keyboard: [[{ text: 'View Report', url: `https://t.me/c/${channelShort}/${firstMessageId}` }]] }
        : undefined;
      await limiter.schedule(() => bot.sendMessage(ADMIN_CHAT_ID, alertText, { parse_mode: 'Markdown', reply_markup: replyMarkup }));
    }

    // User confirmation
    const userReview = `✅ *Report submitted to the ${BOT_NAME}*\n\n` +
      `🧾 *ID:* \`${reportId}\`\n` +
      `${categoryLabel} — ${chainLabel(mainChain)} ${severity}\n` +
      `${isBridge ? `Route: ${chainLabel(data.sourceChain)} → ${chainLabel(data.destChain)}\n` : ''}` +
      `${assetRouteText(data) ? `Asset: ${assetRouteText(data)}\n` : ''}` +
      `${completeness}\n\n` +
      `💼 Wallet: \`${data.wallet ? data.wallet.slice(0, 10) + '...' : 'N/A'}\`\n` +
      `🔗 Source TX: \`${data.sourceTx ? data.sourceTx.slice(0, 12) + '...' : 'N/A'}\`\n` +
      `🔗 Dest TX: \`${data.destTx ? data.destTx.slice(0, 12) + '...' : 'N/A'}\`\n\n` +
      `🛠️ *Suggested next steps:*\n${solutions}\n\n` +
      `The team will review within 24h. Updates via DM or ${SUPPORT_HANDLE} on X.`;
    await limiter.schedule(() => bot.sendMessage(userChatId, userReview, { parse_mode: 'Markdown' }));

    const userButtons = [];
    if (data.sourceTx) {
      const sc = data.sourceChain || mainChain;
      userButtons.push([{ text: `🔍 View Source TX (${sc})`, url: txLink(sc, data.sourceTx) }]);
    }
    if (data.destTx) {
      userButtons.push([{ text: `🔍 View Dest TX (${data.destChain})`, url: txLink(data.destChain, data.destTx) }]);
    }
    userButtons.push(
      [{ text: '📎 Add More Info', callback_data: 'add_more' }],
      [{ text: '❓ Status?', callback_data: 'status' }]
    );
    await limiter.schedule(() => bot.sendMessage(userChatId, '💡 *Quick actions:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: userButtons } }));

  } catch (err) {
    logger.error(`Report send failed for user ${userId}: ${err.message}`, { stack: err.stack, data });
    await limiter.schedule(() => bot.sendMessage(userChatId,
      `⚠️ Submission error — please /start again or contact ${SUPPORT_HANDLE} on X.`,
      { parse_mode: 'Markdown' }
    ));
  }
}

// ---------------------------------------------------------------------------
// Global error handling
// ---------------------------------------------------------------------------
bot.on('polling_error', (err) => logger.error(`Polling error: ${err.message}`, { stack: err.stack }));
bot.on('error', (err) => logger.error(`Bot error: ${err.message}`, { stack: err.stack }));
process.on('uncaughtException', (err) => { logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack }); process.exit(1); });
process.on('unhandledRejection', (reason) => logger.error(`Unhandled rejection: ${reason}`));

logger.info(`🛰️ ${BOT_NAME} v${BOT_VERSION} started — polling for updates...`);
