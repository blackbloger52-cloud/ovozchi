const TelegramBot = require("node-telegram-bot-api");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

ffmpeg.setFfmpegPath(ffmpegPath);

const TOKEN = "8499044134:AAFD4yXHddGFWVZ-qLFZKzUTJ09TlXgqy44";
const bot = new TelegramBot(TOKEN, { polling: true });

const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// Store user sessions: chatId -> { firstFile: string }
const sessions = {};

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function mergeAudio(file1, file2, output) {
  return new Promise((resolve, reject) => {
    const listFile = output + ".txt";
    // ffmpeg concat demuxer
    const content = `file '${file1.replace(/'/g, "'\\''")}'
file '${file2.replace(/'/g, "'\\''")}'
`;
    fs.writeFileSync(listFile, content);

    ffmpeg()
      .input(listFile)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .audioCodec("libopus")
      .outputOptions(["-f", "ogg"])
      .on("end", () => {
        fs.unlinkSync(listFile);
        resolve();
      })
      .on("error", (err) => {
        if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
        reject(err);
      })
      .save(output);
  });
}

function cleanup(...files) {
  for (const f of files) {
    if (f && fs.existsSync(f)) fs.unlinkSync(f);
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  delete sessions[chatId];
  bot.sendMessage(
    chatId,
    "Assalomu alaykum! 👋\n\nMen ikki ovozli xabarni birlashtiruvchi botman.\n\n Boshlash uchun birinchi ovozli xabarni yuboring!"
  );
});

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (sessions[chatId]) {
    cleanup(sessions[chatId].firstFile);
    delete sessions[chatId];
  }
  bot.sendMessage(chatId, "Bekor qilindi. Qaytadan boshlash uchun birinchi ovozli xabarni yuboring.");
});

bot.on("voice", async (msg) => {
  await handleAudio(msg, msg.voice.file_id);
});

bot.on("audio", async (msg) => {
  await handleAudio(msg, msg.audio.file_id);
});

async function handleAudio(msg, fileId) {
  const chatId = msg.chat.id;

  try {
    const fileLink = await bot.getFileLink(fileId);
    const ext = path.extname(new URL(fileLink).pathname) || ".ogg";
    const fileName = `${chatId}_${Date.now()}${ext}`;
    const filePath = path.join(tempDir, fileName);

    await downloadFile(fileLink, filePath);

    if (!sessions[chatId]) {
      // First voice message
      sessions[chatId] = { firstFile: filePath };
      bot.sendMessage(chatId, "Birinchi ovozli xabar qabul qilindi ✅\n\nEndi ikkinchi ovozli xabarni yuboring.");
    } else {
      // Second voice message — merge
      const first = sessions[chatId].firstFile;
      const outputPath = path.join(tempDir, `${chatId}_merged_${Date.now()}.ogg`);
      delete sessions[chatId];

      bot.sendMessage(chatId, "Ikkinchi ovozli xabar qabul qilindi ✅\nBirlashtirilmoqda...");

      await mergeAudio(first, filePath, outputPath);

      await bot.sendVoice(chatId, outputPath, {}, { filename: "merged.ogg", contentType: "audio/ogg" });
      bot.sendMessage(chatId, "Tayyor! ✅\n\nYana birlashtirish uchun ikkita ovozli xabar yuboring.");

      cleanup(first, filePath, outputPath);
    }
  } catch (err) {
    console.error("Xatolik:", err);
    if (sessions[chatId]) {
      cleanup(sessions[chatId].firstFile);
      delete sessions[chatId];
    }
    bot.sendMessage(chatId, "Xatolik yuz berdi ❌\nIltimos, qaytadan urinib ko'ring.");
  }
}

bot.on("message", (msg) => {
  if (msg.voice || msg.audio || (msg.text && msg.text.startsWith("/"))) return;
  bot.sendMessage(msg.chat.id, "Iltimos, menga ovozli xabar yuboring 🎤");
});

console.log("Bot ishga tushdi...");
