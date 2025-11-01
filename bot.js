/**
 * Solana Smart Trader v1.6 (Phantom Connect mode)
 * - Telegram UI (node-telegram-bot-api)
 * - Phantom deep-link connector placeholder
 * - Tracking loop (price checks)
 * - Trade placeholders: tradeEngine.requestBuy(...) / requestSell(...)
 *
 * IMPORTANT:
 * - This file DOES NOT sign or send on-chain txs.
 * - Implement tradeEngine on your secure environment (Phantom webapp / local signer).
 */

import fs from "fs-extra";
import path from "path";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import { PublicKey } from "@solana/web3.js";

dotenv.config();

const TG_BOT_TOKEN =  process.env.BOT_TOKEN;
const TG_ADMIN_CHAT_ID =  process.env.CHAT_ID;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

const TRACK_INTERVAL_SEC = Number(process.env.TRACK_INTERVAL_SEC || 120);
const TRAILING_TRIGGER_PERCENT = Number(process.env.TRAILING_TRIGGER_PERCENT || 20);
const STOPLOSS_PERCENT = Number(process.env.STOPLOSS_PERCENT || 20);

if (!TG_BOT_TOKEN || !TG_ADMIN_CHAT_ID) {
  console.error("Missing TG_BOT_TOKEN or TG_ADMIN_CHAT_ID in .env");
  process.exit(1);
}

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

const DATA_DIR = "./data";
fs.ensureDirSync(DATA_DIR);
const USERS_FILE = path.join(DATA_DIR, "users.json");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");

// init files
if (!fs.existsSync(USERS_FILE)) fs.writeJsonSync(USERS_FILE, { users: [] }, { spaces: 2 });
if (!fs.existsSync(TRADES_FILE)) fs.writeJsonSync(TRADES_FILE, { trades: [] }, { spaces: 2 });

function loadUsers() { return fs.readJsonSync(USERS_FILE); }
function saveUsers(obj) { fs.writeJsonSync(USERS_FILE, obj, { spaces: 2 }); }
function loadTrades() { return fs.readJsonSync(TRADES_FILE); }
function saveTrades(obj) { fs.writeJsonSync(TRADES_FILE, obj, { spaces: 2 }); }

// === Placeholder trade engine API ===
// The bot will call these functions to request a buy/sell.
// Implement tradeEngine as a separate secure service that does the actual sign/send.
// tradeEngine.requestBuy({ user, wallet, tokenMint, amountSol }) => returns { success, id, message, outAmount }
// tradeEngine.requestSell({ user, wallet, tokenMint, qtyRaw }) => returns { success, id, message, tx }
const tradeEngine = {
  // NOTE: these are placeholders. Replace with real RPC to your signer/Phantom app.
  async requestBuy({ user, wallet, tokenMint, amountSol }) {
    // Example: POST to your local signer service or Phantom webapp
    // return await axios.post("https://localhost:9000/buy", {...})
    // For now: return a mocked response so bot logic can proceed in testing mode.
    return {
      success: false,
      message: "tradeEngine.requestBuy not implemented. Implement a secure signer service."
    };
  },
  async requestSell({ user, wallet, tokenMint, qtyRaw }) {
    return { success: false, message: "tradeEngine.requestSell not implemented." };
  }
};

// === Utilities ===
function isValidSolanaAddress(s) {
  try {
    new PublicKey(s);
    return true;
  } catch (e) {
    return false;
  }
}

function genTradeId(tokenMint) {
  return `trade_${tokenMint}_${Date.now()}`;
}

function userByTelegramId(tgId) {
  const u = loadUsers().users.find(x => x.telegram_id === tgId);
  return u || null;
}

// === Inline keyboards & menus ===
function mainMenu(connected) {
  const rows = [
    [
      { text: "🔗 Connect Phantom", callback_data: "connect_phantom" },
      { text: "📋 Paste Token Address", callback_data: "paste_token" }
    ],
    [
      { text: "💸 Buy 0.5 SOL", callback_data: "buy_0.5" },
      { text: "💰 Buy 1 SOL", callback_data: "buy_1" }
    ],
    [
      { text: "⚙ Custom Amount", callback_data: `buytoken_${tokenMint}_custom` },
      { text: "🔍 View Token on Solscan", url: `https://solscan.io/token/${tokenMint}` }
    ],
    [
      { text: "📊 My Trades", callback_data: "my_trades" }
    ],
    [
      { text: `${connected ? "❌ Disconnect Wallet" : "⭕ No Wallet Connected"}`, callback_data: "disconnect_wallet" }
    ]
  ];

  return { reply_markup: { inline_keyboard: rows } };
}

function tradeKeyboard(tradeId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔴 SELL NOW", callback_data: sell_${tradeId} },
          { text: "🔵 CANCEL", callback_data: cancel_${tradeId} }
        ]
      ]
    }
  };
}
// === Price & token helpers ===
// Use Jupiter price API or price.jup.ag
async function getTokenPriceUSD(mint) {
  try {
    const url = `https://price.jup.ag/v4/price?ids=${mint}`;
    const res = await axios.get(url, { timeout: 8000 });
    const data = res.data?.data?.[mint];
    return data?.price || null;
  } catch (e) {
    return null;
  }
}

// === Core logic: tracking loop per trade ===
async function startTracking(trade) {
  // trade = { id, user, wallet, tokenMint, entryPrice, qtyRaw, highest, state }
  if (!trade.interval) {
    trade.interval = setInterval(async () => {
      try {
        const p = await getTokenPriceUSD(trade.tokenMint);
        if (!p) {
          await bot.sendMessage(trade.user, `⚠️ Failed to fetch price for ${trade.tokenMint}`);
          return;
        }
        // update highest
        if (!trade.highest || p > trade.highest) trade.highest = p;
        const profitPct = trade.entryPrice ? ((p - trade.entryPrice) / trade.entryPrice) * 100 : null;
        const drawdownFromPeak = trade.highest ? ((p - trade.highest) / trade.highest) * 100 : null;

        // send status to user
        const holdMin = Math.round((Date.now() - trade.entryTime) / 60000);
        const msg = `💹 ${trade.tokenMint}\n📈 ${profitPct?.toFixed(1) || "?"}% | Hold: ${holdMin}m\n🔝 Peak: ${trade.highest?.toFixed(6) || "?"} | Drawdown: ${drawdownFromPeak?.toFixed(1) || "?"}%\nQty(raw): ${trade.qtyRaw}`;
        await bot.sendMessage(trade.user, msg, tradeKeyboard(trade.id));

        // check auto stoploss / trailing
        if (profitPct !== null && profitPct <= -STOPLOSS_PERCENT) {
          // auto-stoploss
          await bot.sendMessage(trade.user, `🔴 Auto stoploss (${STOPLOSS_PERCENT}%) triggered for ${trade.tokenMint}. Attempting auto-sell...`);
          // call tradeEngine to sell
          const sellResp = await tradeEngine.requestSell({ user: trade.user, wallet: trade.wallet, tokenMint: trade.tokenMint, qtyRaw: trade.qtyRaw });
          if (sellResp.success) {
            clearInterval(trade.interval);
            trade.state = "closed";
            trade.closedAt = Date.now();
            trade.closeReason = "stoploss";
            trade.closeTx = sellResp.tx || null;
            await bot.sendMessage(trade.user, `✅ Auto-sell complete. Tx: ${sellResp.tx || sellResp.message}`);
            // persist changes
            const all = loadTrades();
            all.trades = all.trades.map(t => t.id === trade.id ? trade : t);
            saveTrades(all);
          } else {
            await bot.sendMessage(trade.user, `❌ Auto-sell failed: ${sellResp.message}`);
          }
        } else if (drawdownFromPeak !== null && drawdownFromPeak <= (-TRAILING_TRIGGER_PERCENT)) {
          // trailing sell
          await bot.sendMessage(trade.user, `🔴 Trailing stop (${TRAILING_TRIGGER_PERCENT}% from peak) triggered for ${trade.tokenMint}. Attempting auto-sell...`);
          const sellResp = await tradeEngine.requestSell({ user: trade.user, wallet: trade.wallet, tokenMint: trade.tokenMint, qtyRaw: trade.qtyRaw });
          if (sellResp.success) {
            clearInterval(trade.interval);
            trade.state = "closed";
            trade.closedAt = Date.now();
            trade.closeReason = "trailing";
            trade.closeTx = sellResp.tx || null;
            await bot.sendMessage(trade.user, `✅ Trailing-sell complete. Tx: ${sellResp.tx || sellResp.message}`);
            const all = loadTrades();
            all.trades = all.trades.map(t => t.id === trade.id ? trade : t);
            saveTrades(all);
          } else {
            await bot.sendMessage(trade.user, `❌ Trailing-sell failed: ${sellResp.message}`);
          }
        }

      } catch (e) {
        console.error("Tracking error:", e?.message || e);
      }
    }, TRACK_INTERVAL_SEC * 1000);
  }
}

// === Telegram handlers & flows ===
bot.
onText(/\/start/, async (msg) => {
  const tgId = msg.from.id;
  const users = loadUsers();
  const user = users.users.find(u => u.telegram_id === tgId);
  const connected = !!user?.wallet;
  await bot.sendMessage(tgId, "🤖 Solana Smart Trader v1.6 — Phantom Connect Mode\nUse the menu below:", mainMenu(connected));
});

// callback queries for inline buttons
bot.on("callback_query", async (q) => {
  const data = q.data;
  const tgId = q.from.id;
  try {
    if (data === "connect_phantom") {
      // Provide instructions + deep link template
      const dappUrl = process.env.PHANTOM_DEEP_LINK_APP_URL || "https://example-dapp.local";
      const msg =  `📱 To connect Phantom on mobile: open Phantom on the SAME phone where Telegram is running.\n\nPress the button below to open Phantom Connect flow (you must approve inside Phantom).`;
      // NOTE: creating a true deep-link requires a dapp encryption key & redirect; here we provide an instructions button linking to a small doc or your phantom-connect webapp
      await bot.sendMessage(tgId, msg, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🟢 Open Phantom Connect (instructions / webapp)", url: dappUrl }],
            [{ text: "✏️ Or paste your wallet address manually", callback_data: "manual_wallet" }]
          ]
        }
      });
    } else if (data === "manual_wallet") {
      await bot.sendMessage(tgId, "💬 Please paste your Solana wallet address (public key only):");
      bot.once("message", async (m) => {
        const txt = (m.text || "").trim();
        if (!isValidSolanaAddress(txt)) {
          return bot.sendMessage(tgId, "❌ Invalid Solana address. Try again.");
        }
        const users = loadUsers();
        users.users = users.users.filter(u => u.telegram_id !== tgId); // remove old if exist
        users.users.push({ telegram_id: tgId, wallet: txt, connected: true, phantom_session: null });
        saveUsers(users);
        await bot.sendMessage(tgId, `✅ Wallet connected: ${txt}\nYou can now paste a token address and BUY.`);
      });
    } else if (data === "paste_token") {
      await bot.sendMessage(tgId, "💬 Paste Solscan token link or mint address:");
      bot.once("message", async (m) => {
        const txt = (m.text || "").trim();
        const tokenMint = txt.includes("solscan.io") ? txt.split("/").pop().trim() : txt;
        if (!isValidSolanaAddress(tokenMint)) {
          return bot.sendMessage(tgId, "❌ Invalid token mint. Try again.");
        }
        // store temporary active token for this chat
        await bot.sendMessage(tgId, `✅ Token detected: ${tokenMint}\nChoose buy amount:`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💸 Buy 0.5 SOL", callback_data: `buytoken_${tokenMint}_0.5` }, { text: "💰 Buy 1 SOL", callback_data: `buytoken_${tokenMint}_1` }],
              [{ text: "⚙️ Custom", callback_data: buytoken_${tokenMint}_custom }, { text: "🔍 View on Solscan", url: https://solscan.io/token/${tokenMint} }]
            ]
          }
        });
      });
    } else if (data && data.startsWith("buytoken_")) {
      // format: buytoken_<mint>_<amount or custom>
      const parts = data.split("_");
      const tokenMint = parts[1];
      const amountPart = parts[2];
      const users = loadUsers();
      const user = users.users.find(u => u.telegram_id === tgId);
      if (!user || !user.wallet) return bot.sendMessage(tgId, "⚠️ Please connect your wallet first (Connect Phantom).");
      let amountSol = null;
      if (amountPart === "custom") {
        await bot.sendMessage(tgId, "💬 Enter custom amount in SOL (e.g., 0.2):");
        bot.once("message", async (m) => {
          const a = parseFloat((m.text || "").trim());
          if (!a  isNaN(a)  a <= 0) return bot.sendMessage(tgId, "❌ Invalid amount.");
          // call tradeEngine to request buy
          await bot.sendMessage(tgId, `⏳ Requesting buy ${a} SOL -> ${tokenMint} (via your Phantom session)...`);
          const resp = await tradeEngine.requestBuy({ user: tgId, wallet: user.const users = loadUsers();
      const userIdx = users.users.findIndex(u => u.telegram_id === tgId);
      if (userIdx === -1) return bot.sendMessage(tgId, "No wallet connected.");
      const user = users.users[userIdx];
      // cancel open trades for this wallet
      const trades = loadTrades();
      for (const t of trades.trades.filter(x => x.wallet === user.wallet && x.state === "open")) {
        if (t.interval) clearInterval(t.interval);
        t.state = "closed";
        t.closeReason = "wallet_disconnected";
      }
      // persist trades
      saveTrades(trades);
      // remove user
      users.users.splice(userIdx, 1);
      saveUsers(users);
      await bot.sendMessage(tgId, `✅ Wallet disconnected and open trades cancelled. You can connect a new wallet now.`);
    } else if (data === "view_token") {
      await bot.sendMessage(tgId, "Use Paste Token Address first to view token.");
    }
  } catch (err) {
    console.error("callback error:", err?.message || err);
  }
});

// Admin command to list users & trades
bot.onText(/\/admin_report/, async (msg) => {
  if (String(msg.from.id) !== String(TG_ADMIN_CHAT_ID)) return;
  const users = loadUsers();
  const trades = loadTrades();
  await bot.sendMessage(TG_ADMIN_CHAT_ID, `Users: ${users.users.length}, Trades open: ${trades.trades.filter(t => t.state === "open").length}`);
});

// startup message
(async () => {
  await bot.sendMessage(TG_ADMIN_CHAT_ID, "Solana Smart Trader v1.6 (controller) online. Use /start in your chat to open menu.");
})();











