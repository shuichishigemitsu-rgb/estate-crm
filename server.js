const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '.')));

// データの保存ファイルパス
const DATA_FILE = path.join(__dirname, 'customers.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// --- Nodemailer (メール送信) の設定 ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'shuichi.shigemitsu@gmail.com',
    pass: 'fqoprrxomcyayrbl'
  }
});

// --- Gmail IMAP (メール受信) の設定 ---
const imapConfig = {
  user: 'shuichi.shigemitsu@gmail.com',
  password: 'fqoprrxomcyayrbl',
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }
};

function startEmailListener() {
  const imap = new Imap(imapConfig);

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) {
        console.error('[IMAPエラー] インボックスを開けませんでした:', err);
        return;
      }
      console.log('[IMAP接続成功] Gmail新着メールの監視を開始しました（10秒間隔・既読含む）');

      // 1. 10秒おきにチェック
      // 2. ['ALL'] で未読・既読問わず取得し、直近のメールを対象にする
      setInterval(() => {
        imap.search(['ALL'], (err, results) => {
          if (err || !results || results.length === 0) return;

          // サーバー負荷と重複を防ぐため、直近の最新15件に絞ってチェック
          const targetResults = results.slice(-15);

          const f = imap.fetch(targetResults, { bodies: '' });
          f.on('message', (msg, seqno) => {
            msg.on('body', (stream) => {
              simpleParser(stream, async (err, parsed) => {
                if (err) return;

                const fromEmail = parsed.from?.value?.[0]?.address;
                if (!fromEmail) return;

                const subject = parsed.subject || '';
                const text = parsed.text || parsed.html || '';
                // メール固有のID（なければ差件名日時から生成）
                const messageId = parsed.messageId || `${fromEmail}-${parsed.date}-${subject}`;

                const customers = loadCustomers();
                const matchedCustomer = customers.find(c => 
                  c.email1 === fromEmail || c.email2 === fromEmail || c.email3 === fromEmail
                );

                if (matchedCustomer) {
                  const storageKey = matchedCustomer.email1 || matchedCustomer.id.toString();
                  const messages = loadMessages();
                  if (!messages[storageKey]) messages[storageKey] = [];

                  // 既読・未読問わず、すでに取得済みのメッセージID（または同一テキスト）がないか厳密にチェック
                  const exists = messages[storageKey].some(m => m.messageId === messageId || (m.text === text && m.sender === 'customer'));
                  
                  if (!exists) {
                    messages[storageKey].push({
                      sender: 'customer',
                      text: text,
                      channelInfo: `メール受信 (${fromEmail})`,
                      timestamp: new Date().toISOString(),
                      messageId: messageId
                    });
                    saveMessages(messages);
                    console.log(`[CRM同期成功] ${matchedCustomer.sei} ${matchedCustomer.mei}様からのメールをチャットに反映しました`);
                  }
                }
              });
            });
          });
        });
      }, 10000); // 10秒おきに変更
    });
  });

  imap.once('error', (err) => {
    console.error('[IMAP接続エラー]', err);
    setTimeout(startEmailListener, 10000);
  });

  imap.connect();
}

// 顧客データの読み込み
function loadCustomers() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

// 顧客データの保存
function saveCustomers(customers) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(customers, null, 2), 'utf8');
}

// メッセージデータの読み込み
function loadMessages() {
  if (!fs.existsSync(MESSAGES_FILE)) return {};
  try {
    const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return {};
  }
}

// メッセージデータの保存
function saveMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf8');
}

// メッセージ追記用のヘルパー関数
function appendMessageToStorage(storageKey, sender, text) {
  const messages = loadMessages();
  if (!messages[storageKey]) messages[storageKey] = [];
  messages[storageKey].push({
    sender: sender,
    text: text,
    timestamp: new Date().toISOString()
  });
  saveMessages(messages);
}

// 1. 顧客一覧の取得
app.get('/api/customers', (req, res) => {
  const customers = loadCustomers();
  res.json(customers);
});

// 2. 顧客データの保存（新規・更新）
app.post('/api/customers', (req, res) => {
  const customers = req.body;
  if (!Array.isArray(customers)) {
    return res.status(400).json({ success: false, error: '配列形式である必要があります' });
  }
  saveCustomers(customers);
  res.json({ success: true });
});

// 3. チャット履歴の取得
app.get('/api/messages', (req, res) => {
  const messages = loadMessages();
  res.json(messages);
});

// 4. LINEメッセージ送信API
app.post('/api/send', async (req, res) => {
  const { userId, text } = req.body;

  if (!userId || !text) {
    return res.status(400).json({ success: false, error: 'userId と text は必須です' });
  }

  const CHANNEL_ACCESS_TOKEN = 'fwY9WH/PYZRNoy/5RLo98nlQpbW4DgGRzybZ8fX/jurU+SjOePQJoKc8YxoBBUxy+hJaEP95ibsJMldM29oaE/Qa9k52jJldp94QDPhDJM0nch7JbIzE9oOpTSlR98wr6kGx0TXSuzf7uzZ/r3T6XwdB04t89/1O/w1cDnyilFU=';

  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to: userId,
      messages: [{ type: 'text', text: text }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
      }
    });

    console.log(`[PCから LINE送信成功] 宛先: ${userId} / 本文: ${text}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[LINE送信エラー]', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// 5. メール送信API (Nodemailer)
app.post('/api/send-email', async (req, res) => {
  const { email, subject, text } = req.body;

  if (!email || !text) {
    return res.status(400).json({ success: false, error: 'メールアドレスと本文は必須です' });
  }

  try {
    await transporter.sendMail({
      from: '"山科新店舗 賃貸窓口" <shuichi.shigemitsu@gmail.com>',
      to: email,
      subject: subject || '【山科新店舗】お問い合わせ・物件のご案内について',
      text: text
    });

    console.log(`[PCから メール送信成功] 宛先: ${email} / 本文: ${text}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[メール送信エラー]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. LINE Webhook受信エンドポイント
app.post('/api/webhook', (req, res) => {
  const body = req.body;

  if (body.events) {
    body.events.forEach(event => {
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const text = event.message.text;

        appendMessageToStorage(userId, 'customer', text);
        console.log(`[LINE受信成功] 差出人(UserId): ${userId} / 本文: ${text}`);
      }
    });
  }

  res.status(200).json({ success: true });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`CRM Back-end Server running on port ${PORT}`);
  startEmailListener();
});