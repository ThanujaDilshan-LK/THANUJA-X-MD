const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['💋', '🍬', '🫆', '💗', '🎈', '🎉', '🥳', '❤️', '🧫', '🐭'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/BkjrMld0nic2dNeRwXWIi5',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: './sulabot.jpg',
    NEWSLETTER_JID: '120363421363503978@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94760663483',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb7GtMHAInPngEYONu0g'
};

const octokit = new Octokit({ auth: 'github token' });// ඔයා 𝚐𝚒𝚝𝚑𝚞𝚋 𝚝𝚘𝚔𝚎𝚗 එකක් අරන් ඒක දාන්න
const owner = 'your username';//ThanujaDilshan-LK
const repo = 'repo name';//THANUJA-X-MD

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}
// CREATE BY SULA MD
async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Clean duplicate session file: ${sessionFiles[i].name}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }
    } catch (error) {
        console.error('Failed to clean duplicate session files:', error);
    }
}

async function updateNumberListOnGitHub(newNumber) {
    try {
        let numbers = [];
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: 'numbers.json'
            });
            numbers = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
            sha = data.sha;
        } catch (error) {
            // File might not exist yet
        }

        if (!numbers.includes(newNumber)) {
            numbers.push(newNumber);
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: 'numbers.json',
                message: `Update number list with ${newNumber}`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64'),
                sha
            });
            console.log(`Updated numbers.json on GitHub with ${newNumber}`);
        }
    } catch (error) {
        console.error('Failed to update number list on GitHub:', error);
    }
}

async function joinGroup(socket) {
    try {
        const code = config.GROUP_INVITE_LINK.split('https://chat.whatsapp.com/')[1];
        await socket.groupAcceptInvite(code);
        return { success: true };
    } catch (error) {
        console.error('Failed to join group:', error);
        return { success: false, error: error.message };
    }
}

async function loadNewsletterJIDsFromRaw() {
    try {
        const rawUrl = 'https://raw.githubusercontent.com/Sulakshamadara/SULA-MD-FREE-BOT/refs/heads/main/NEWSLETTER_JID.json';
        const response = await axios.get(rawUrl);
        return response.data;
    } catch (error) {
        console.error('Failed to load newsletter JIDs from raw:', error);
        return [config.NEWSLETTER_JID];
    }
}

function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (msg.key.remoteJid === 'status@broadcast') {
            if (config.AUTO_VIEW_STATUS === 'true') {
                await socket.readMessages([msg.key]);
                console.log(`Viewed status from: ${msg.key.participant}`);
            }
            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                await socket.sendMessage('status@broadcast', {
                    react: { text: randomEmoji, key: msg.key }
                }, { statusJidList: [msg.key.participant] });
                console.log(`Liked status from: ${msg.key.participant} with ${randomEmoji}`);
            }
        }
    });
}

function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (msg.messageStubType === 68) { // REVOKE message
            console.log(`Message revoked by: ${msg.key.participant || msg.key.remoteJid}`);
            // Logic to handle revoked messages if needed
        }
    });
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (msg.key.remoteJid === config.NEWSLETTER_JID) {
            console.log('Received message from newsletter');
            // Newsletter handling logic
        }
    });
}

async function downloadAndSaveMediaMessage(message, filename, attachExtension = true) {
    const { downloadContentFromMessage } = require('baileys');
    const FileType = require('file-type');
    
    let quoted = message.msg ? message.msg : message;
    let mime = (message.msg || message).mimetype || '';
    let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
    const stream = await downloadContentFromMessage(quoted, messageType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    let type = await FileType.fromBuffer(buffer);
    let trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
    await fs.writeFileSync(trueFileName, buffer);
    return trueFileName;
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
            ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
            ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
            ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
            ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
            ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
            ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
            ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                || msg.text) 
            : (type === 'viewOnceMessage') 
            ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
            ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
            : '';
        
        let sender = msg.key.remoteJid;
        var prefix = config.PREFIX;
        var isCmd = body.startsWith(prefix);
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        
        if (!command) return;

        try {
            switch (command) {
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const captionText = `
╭────◉◉◉────៚
⏰ Bot Uptime: ${hours}h ${minutes}m ${seconds}s
🟢 Active session: ${activeSockets.size}
╰────◉◉◉────៚

🔢 Your Number: ${number}

*▫️SULA-MD Main Website 🌐*
> https://sula-md.pages.dev
`;

                    const templateButtons = [
                        {
                            buttonId: `${config.PREFIX}menu`,
                            buttonText: { displayText: 'MENU' },
                            type: 1,
                        }
                    ];

                    await socket.sendMessage(m.chat, {
                        buttons: templateButtons,
                        headerType: 1,
                        viewOnce: true,
                        image: { url: "https://i.ibb.co/TDgzTB29/SulaMd.png" },
                        caption: `𝐒𝚄𝙻𝙰 𝐌𝙳 𝐅𝚁𝙴𝙴 𝐁𝙾𝚃 𝐀𝙻𝙸𝚅𝙴 𝐍𝙾𝐖\n\n${captionText}`,
                    }, { quoted: msg });

                    break;
                }
                case 'menu': {
                    const captionText = `
➤ Available Commands..!! 🌐💭*

┏━━━━━━━━━━━ ◉◉➢
┇ *\`${config.PREFIX}alive\`*
┋ • Show bot status
┋
┇ *\`${config.PREFIX}menu\`*
┋ • Show this menu
┗━━━━━━━━━━━ ◉◉➣
`;

                    const templateButtons = [
                        {
                            buttonId: `${config.PREFIX}alive`,
                            buttonText: { displayText: 'ALIVE' },
                            type: 1,
                        }
                    ];

                    await socket.sendMessage(m.chat, {
                        buttons: templateButtons,
                        headerType: 1,
                        viewOnce: true,
                        image: { url: "https://i.ibb.co/TDgzTB29/SulaMd.png" },
                        caption: `𝐒𝚄𝙻𝙰 𝐌𝙳 𝐅𝚁𝙴𝙴 𝐁𝙾𝚃 𝐋𝙸𝚂𝚃 𝐌𝙴𝙽𝚄\n\n${captionText}`,
                    }, { quoted: msg });

                    break;
                }
            }
        } catch (error) {
            console.error('Command handler error:', error);
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {}

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                await deleteSessionFromGitHub(number);
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                }
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
            } else {
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    try {
        const socket = makeWASocket({
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            version: [2, 3000, 1033105955],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            fireInitQueries: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            browser: ['Mac OS', 'Safari', '10.15.7']
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            let sha;
            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`
                });
                sha = data.sha;
            } catch (error) {}

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: `session/creds_${sanitizedNumber}.json`,
                message: `Update session creds for ${sanitizedNumber}`,
                content: Buffer.from(fileContent).toString('base64'),
                sha
            });
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                await delay(3000);
                await joinGroup(socket);
            }
        });

        activeSockets.set(sanitizedNumber, socket);
    } catch (error) {
        console.error('EmpirePair error:', error);
    }
}

router.get('/', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).send({ error: 'Number is required' });
    await EmpirePair(number, res);
});

module.exports = router;
