const TelegramBot = require("node-telegram-bot-api");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const ytdlp = require("yt-dlp-exec");

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

const INSTAGRAM_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\/[\w-]+/i;

async function downloadInstagramAudio(url, outputPath) {
  const rawPath = outputPath + ".raw";
  await ytdlp(url, {
    extractAudio: true,
    audioFormat: "opus",
    output: rawPath,
    noCheckCertificates: true,
  });

  // yt-dlp may add its own extension, find the actual file
  const dir = path.dirname(rawPath);
  const base = path.basename(rawPath);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(path.parse(base).name));
  const downloaded = files.length > 0 ? path.join(dir, files[0]) : rawPath;

  // Convert to OGG/Opus voice format
  return new Promise((resolve, reject) => {
    ffmpeg(downloaded)
      .audioCodec("libopus")
      .outputOptions(["-f", "ogg"])
      .on("end", () => {
        if (downloaded !== outputPath && fs.existsSync(downloaded)) fs.unlinkSync(downloaded);
        resolve(outputPath);
      })
      .on("error", (err) => {
        if (downloaded !== outputPath && fs.existsSync(downloaded)) fs.unlinkSync(downloaded);
        reject(err);
      })
      .save(outputPath);
  });
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  delete sessions[chatId];
  bot.sendMessage(
    chatId,
    "Assalomu alaykum! 👋\n\nMen ikki ovozli xabarni birlashtiruvchi botman.\n\nMenga ovozli xabar, video, audio yoki Instagram havolasini yuboring!\n\n/skip — birlashtirishsiz yuborish\n/cancel — bekor qilish"
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

bot.onText(/\/skip/, async (msg) => {
  const chatId = msg.chat.id;
  if (!sessions[chatId]) {
    bot.sendMessage(chatId, "Hozircha hech qanday audio yo'q. Avval ovozli xabar yoki Instagram havolasini yuboring.");
    return;
  }
  const filePath = sessions[chatId].firstFile;
  delete sessions[chatId];
  try {
    await bot.sendVoice(chatId, filePath, {}, { filename: "voice.ogg", contentType: "audio/ogg" });
    bot.sendMessage(chatId, "Tayyor! ✅\n\nYana birlashtirish uchun ovozli xabar yoki Instagram havolasini yuboring.");
  } catch (err) {
    console.error("Skip xatolik:", err);
    bot.sendMessage(chatId, "Xatolik yuz berdi ❌\nIltimos, qaytadan urinib ko'ring.");
  }
  cleanup(filePath);
});

bot.on("voice", async (msg) => {
  await handleAudio(msg, msg.voice.file_id);
});

bot.on("audio", async (msg) => {
  await handleAudio(msg, msg.audio.file_id);
});

bot.on("video", async (msg) => {
  await handleVideo(msg, msg.video.file_id);
});

bot.on("video_note", async (msg) => {
  await handleVideo(msg, msg.video_note.file_id);
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

function convertVideoToVoice(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("libopus")
      .outputOptions(["-f", "ogg"])
      .on("end", () => {
        cleanup(videoPath);
        resolve(outputPath);
      })
      .on("error", (err) => {
        cleanup(videoPath);
        reject(err);
      })
      .save(outputPath);
  });
}

async function handleVideo(msg, fileId) {
  const chatId = msg.chat.id;

  try {
    const fileLink = await bot.getFileLink(fileId);
    const ext = path.extname(new URL(fileLink).pathname) || ".mp4";
    const videoPath = path.join(tempDir, `${chatId}_video_${Date.now()}${ext}`);
    const oggPath = path.join(tempDir, `${chatId}_vogg_${Date.now()}.ogg`);

    bot.sendMessage(chatId, "Video dan audio ajratilmoqda... ⏳");
    await downloadFile(fileLink, videoPath);
    await convertVideoToVoice(videoPath, oggPath);

    if (!sessions[chatId]) {
      sessions[chatId] = { firstFile: oggPath };
      bot.sendMessage(chatId, "Video audio qabul qilindi ✅\n\nEndi ikkinchi ovozli xabar, video, audio yoki Instagram havolasini yuboring.\n/skip — birlashtirishsiz yuborish");
    } else {
      const first = sessions[chatId].firstFile;
      const mergedPath = path.join(tempDir, `${chatId}_merged_${Date.now()}.ogg`);
      delete sessions[chatId];

      bot.sendMessage(chatId, "Ikkinchi audio qabul qilindi ✅\nBirlashtirilmoqda...");

      await mergeAudio(first, oggPath, mergedPath);

      await bot.sendVoice(chatId, mergedPath, {}, { filename: "merged.ogg", contentType: "audio/ogg" });
      bot.sendMessage(chatId, "Tayyor! ✅\n\nYana birlashtirish uchun ovozli xabar, video, audio yoki Instagram havolasini yuboring.");

      cleanup(first, oggPath, mergedPath);
    }
  } catch (err) {
    console.error("Video xatolik:", err);
    if (sessions[chatId]) {
      cleanup(sessions[chatId].firstFile);
      delete sessions[chatId];
    }
    bot.sendMessage(chatId, "Video dan audio ajratishda xatolik yuz berdi ❌\nIltimos, qaytadan urinib ko'ring.");
  }
}

bot.on("message", async (msg) => {
  if (msg.voice || msg.audio || msg.video || msg.video_note || (msg.text && msg.text.startsWith("/"))) return;

  // Check for Instagram link
  if (msg.text) {
    const match = msg.text.match(INSTAGRAM_REGEX);
    if (match) {
      await handleInstagramLink(msg, match[0]);
      return;
    }
  }

  bot.sendMessage(msg.chat.id, "Iltimos, menga ovozli xabar, video, audio yoki Instagram havolasini yuboring 🎤");
});

async function handleInstagramLink(msg, url) {
  const chatId = msg.chat.id;
  const outputPath = path.join(tempDir, `${chatId}_insta_${Date.now()}.ogg`);

  try {
    bot.sendMessage(chatId, "Instagram dan audio yuklanmoqda... ⏳");
    await downloadInstagramAudio(url, outputPath);

    if (!sessions[chatId]) {
      // First audio — save and wait for second
      sessions[chatId] = { firstFile: outputPath };
      bot.sendMessage(chatId, "Instagram audio qabul qilindi ✅\n\nEndi ikkinchi ovozli xabar yoki Instagram havolasini yuboring.");
    } else {
      // Second audio — merge
      const first = sessions[chatId].firstFile;
      const mergedPath = path.join(tempDir, `${chatId}_merged_${Date.now()}.ogg`);
      delete sessions[chatId];

      bot.sendMessage(chatId, "Ikkinchi audio qabul qilindi ✅\nBirlashtirilmoqda...");

      await mergeAudio(first, outputPath, mergedPath);

      await bot.sendVoice(chatId, mergedPath, {}, { filename: "merged.ogg", contentType: "audio/ogg" });
      bot.sendMessage(chatId, "Tayyor! ✅\n\nYana birlashtirish uchun ovozli xabar yoki Instagram havolasini yuboring.");

      cleanup(first, outputPath, mergedPath);
    }
  } catch (err) {
    console.error("Instagram xatolik:", err);
    cleanup(outputPath);
    if (sessions[chatId]) {
      cleanup(sessions[chatId].firstFile);
      delete sessions[chatId];
    }
    bot.sendMessage(chatId, "Instagram dan audio yuklashda xatolik yuz berdi ❌\nHavola to'g'ri ekanligiga ishonch hosil qiling va qaytadan urinib ko'ring.");
  }
}

console.log("Bot ishga tushdi...");
