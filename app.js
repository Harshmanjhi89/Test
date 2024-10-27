const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { harem, haremCallback } = require('./modules/harem');
const { inlineQuery } = require('./modules/inline');
const { start } = require('./modules/start');
const { balance, pay, dailyReward } = require('./modules/bal'); 
const { ctop, globalLeaderboard, stats, sendUsersDocument, sendGroupsDocument, handleTopCommand } = require('./modules/top');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 8000;  // Hardcoded port number
const FormData = require('form-data');
const { createCanvas, loadImage } = require('canvas');

// Add these global variables if not already present
const activeGames = {};

require('dotenv').config();

const OWNER_ID = 6359642834;
const sudo_users = ["7900160187", "6942703687", "6359642834", "7388651017"];
const CHARA_CHANNEL_ID = '-1002304009452';


// Emojis for games
const emojis = ["👍", "😘", "❤️", "🔥", "🥰", "🤩", "💘", "💯", "✨", "⚡️", "🏆", "🤭", "🎉"];

// Rarity weights for character selection
const RARITY_WEIGHTS = {
    "⚪️ Common": 12,
    "🟣 Rare": 0.2,
    "🟡 Legendary": 4.5,
    "🟢 Medium": 12,
    "💮 Special edition": 0.2,
    "🔮 Limited Edition": 0.1
};

const rarity_map = {
    1: "⚪️ Common",
    2: "🟣 Rare",
    3: "🟡 Legendary",
    4: "🟢 Medium",
    5: "💮 Special Edition",
    6: "🔮 Limited Edition",
    7: "💸 Premium Edition"
};

// Global variables
const locks = {};
const lastUser = {};
const warnedUsers = {};
const messageCounts = {};
const sentCharacters = {};
const lastCharacters = {};
const firstCorrectGuesses = {};

const bot = new Telegraf(process.env.BOT_TOKEN);

const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;
const client = new MongoClient(MONGODB_URI);

let db, userTotalsCollection, groupUserTotalsCollection, topGlobalGroupsCollection, pmUsersCollection, destinationCollection, destinationCharCollection;


async function connectToDatabase() {
    try {
        await client.connect();
        console.log('Connected to MongoDB');

        // Set the database
        db = client.db('gaming_create'); // Use 'gaming_create' as the database name

        // Initialize collections
        userTotalsCollection = db.collection('gaming_totals');
        groupUserTotalsCollection = db.collection('gaming_group_total');
        topGlobalGroupsCollection = db.collection('gaming_global_groups');
        pmUsersCollection = db.collection('gaming_pm_users');
        destinationCollection = db.collection('gamimg_user_collection'); // Note: Check if the collection name is correct (typo in "gamimg")
        destinationCharCollection = db.collection('gaming_anime_characters');

        // Create an index on the 'id' field
        await destinationCharCollection.createIndex({ id: 1 });
        console.log('Index on "id" field created for destinationCharCollection.');


        console.log('All collections initialized');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}


async function importModules() {
  const modulesDir = path.join(__dirname, 'modules');
  const files = fs.readdirSync(modulesDir);

  for (const file of files) {
    if (file.endsWith('.js')) {
      const modulePath = path.join(modulesDir, file);
      try {
        const module = require(modulePath);
        
        // If the module exports a function, run it with the bot instance
        if (typeof module === 'function') {
          module(bot);
        } 
        // If the module exports an object with setup function, run it
        else if (typeof module === 'object' && typeof module.setup === 'function') {
          module.setup(bot);
        }
        // Otherwise, assume it exports individual handlers and register them
        else if (typeof module === 'object') {
          Object.entries(module).forEach(([key, handler]) => {
            if (typeof handler === 'function') {
              bot.use(handler);
            }
          });
        }
        
        console.log(`Loaded module: ${file}`);
      } catch (error) {
        console.error(`Error loading module ${file}:`, error);
      }
    }
  }
}

async function reactToMessage(chatId, messageId) {
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    try {
        await bot.telegram.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: randomEmoji }]);
    } catch (error) {
        console.error("Error setting reaction:", error);
    }
}

async function sendImage(ctx) {
    const chatId = ctx.chat.id;
    const allCharacters = await destinationCharCollection.find({}).toArray();

    // Initialize sentCharacters for the chat if not already done
    if (!sentCharacters[chatId]) {
        sentCharacters[chatId] = [];
    }

    // Reset sentCharacters if all have been sent
    if (sentCharacters[chatId].length === allCharacters.length) {
        sentCharacters[chatId] = [];
    }

    // Generate available characters based on the rarity
    const availableCharacters = allCharacters.filter(c =>
        c.id &&
        !sentCharacters[chatId].includes(c.id) &&
        c.rarity != null &&
        c.rarity !== '💸 Premium Edition'
    );

    if (availableCharacters.length === 0) {
        await ctx.reply("No characters available to send.");
        return;
    }

    // Calculate cumulative weights
    const cumulativeWeights = [];
    let cumulativeWeight = 0;
    for (const character of availableCharacters) {
        cumulativeWeight += RARITY_WEIGHTS[character.rarity] || 1;
        cumulativeWeights.push(cumulativeWeight);
    }

    const rand = Math.random() * cumulativeWeight;
    let selectedCharacter = availableCharacters.find((_, i) => rand <= cumulativeWeights[i]);

    // Generating a character code
    const characterCode = `#${Math.floor(Math.random() * 90000) + 10000}`;
    selectedCharacter.code = characterCode;

    // Send the character image
    const sentMessage = await ctx.replyWithPhoto(selectedCharacter.img_url, {
        caption: `✨ A Wild ${selectedCharacter.rarity} Character Appeared! ✨\n` +
                 `🔍 Use /guess to identify and add this mysterious character to your Harem!\n` +
                 `💫 Quick, before someone else claims them!`,
        parse_mode: 'Markdown'
    });

    // Store the last character and message ID
    lastCharacters[chatId] = selectedCharacter;
    lastCharacters[chatId].message_id = sentMessage.message_id;
    ctx.chat.characterGameActive = true; // Set game active
}

async function guessCommand(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    // Check if there is an active character to guess
    if (!lastCharacters[chatId]) {
        await ctx.reply("❌ There is currently no active character to guess. Please wait for the next round.");
        return;
    }

    // Get the guess from the message
    const guess = ctx.message.text.split(' ').slice(1).join(' ').toLowerCase() || ctx.message.text.toLowerCase();

    if (!guess) {
        await ctx.reply("❌ Please enter a name to make a guess.");
        return;
    }

    const nameParts = lastCharacters[chatId].name.toLowerCase().split(' ');

    // Check if guess matches
    const isCorrectGuess = nameParts.some(name => name === guess);

    if (isCorrectGuess) {
        firstCorrectGuesses[chatId] = userId;

        try {
            const user = await destinationCollection.findOne({ id: userId });
            const updateFields = {};
            if (ctx.from.username && ctx.from.username !== user?.username) {
                updateFields.username = ctx.from.username;
            }
            if (ctx.from.first_name !== user?.first_name) {
                updateFields.first_name = ctx.from.first_name;
            }
            if (Object.keys(updateFields).length > 0) {
                await destinationCollection.updateOne({ id: userId }, { $set: updateFields });
            }

            // Update user's characters
            if (user) {
                await destinationCollection.updateOne({ id: userId }, { $push: { characters: lastCharacters[chatId] } });
            } else {
                await destinationCollection.insertOne({
                    id: userId,
                    username: ctx.from.username,
                    first_name: ctx.from.first_name,
                    characters: [lastCharacters[chatId]],
                });
            }

            await reactToMessage(chatId, ctx.message.message_id);

            // Update user balance
            const userBalance = await destinationCollection.findOne({ id: userId });
            let newBalance = 40;
            if (userBalance) {
                newBalance = (userBalance.balance || 0) + 40;
                await destinationCollection.updateOne({ id: userId }, { $set: { balance: newBalance } });
            } else {
                await destinationCollection.insertOne({ id: userId, balance: newBalance });
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.switchToChat("See Harem", `collection.${userId}`)]
            ]);

            await ctx.reply(
                `🌟 <b><a href="tg://user?id=${userId}">${ctx.from.first_name}</a></b>, you've captured a new character! 🎊\n\n` +
                `📛 𝗡𝗔𝗠𝗘: <b>${lastCharacters[chatId].name}</b> \n` +
                `🌈 𝗔𝗡𝗜𝗠𝗘: <b>${lastCharacters[chatId].anime}</b> \n` +
                `✨ 𝗥𝗔𝗥𝗜𝗧𝗬: <b>${lastCharacters[chatId].rarity}</b>\n\n` +
                'This magical being has been added to your harem. Use /harem to view your growing collection!',
                { parse_mode: 'HTML', ...keyboard }
            );

            // Reset game state for the next round
            lastCharacters[chatId] = null;
            firstCorrectGuesses[chatId] = null;
            ctx.chat.characterGameActive = false;

        } catch (error) {
            console.error("Error processing correct guess:", error);
            await ctx.reply('❌ An error occurred while processing your guess. Please try again later.');
        }
    } 
}

async function favCommand(ctx) {
    const userId = ctx.from.id;

    if (!ctx.message.text.split(' ')[1]) {
        await ctx.reply('Please provide Character id...');
        return;
    }

    const characterId = ctx.message.text.split(' ')[1];

    const user = await destinationCollection.findOne({ id: userId });
    if (!user) {
        await ctx.reply('You have not guessed any characters yet....');
        return;
    }

    const character = user.characters.find(c => c.id === characterId);
    if (!character) {
        await ctx.reply('This character is not in your collection');
        return;
    }

    await destinationCollection.updateOne({ id: userId }, { $set: { favorites: [characterId] } });

    await ctx.reply(`Character ${character.name} has been added to your favorites...`);
}

async function nowCommand(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    
    if (userId !== OWNER_ID) {
        await ctx.reply("You are not authorized to use this command.");
        return;
    }
    
    const gameType = ctx.message.text.split(' ')[1]?.toLowerCase();
    
    if (!gameType) {
        await ctx.reply("Usage: /now {character}");
        return;
    }
    
    if (gameType === 'character') {
        await sendImage(ctx);
    } else {
        await ctx.reply("Invalid game type. Use 'character'.");
    }
}

async function messageCounter(ctx) {
    const chatId = ctx.chat.id.toString();
    const userId = ctx.from.id;

    // Only proceed if the chat is a group or supergroup
    if (!['group', 'supergroup'].includes(ctx.chat.type)) {
        return;
    }

    // Initialize message counts for games if not present
    messageCounts[chatId] = messageCounts[chatId] || { character: 0, word: 0, math: 0 };

    // Increment all counters at once
    messageCounts[chatId].character++;
    messageCounts[chatId].word++;
    messageCounts[chatId].math++;

    // Check and trigger games if thresholds are met
    if (messageCounts[chatId].character >= 80) {
        await sendImage(ctx);
        messageCounts[chatId].character = 0;
    }

    if (messageCounts[chatId].math >= 14) {
        await sendMathGame(ctx);
        messageCounts[chatId].math = 0;
    }

    if (messageCounts[chatId].word >= 12) {
        await sendWordGameImage(ctx);
        messageCounts[chatId].word = 0;
    }

    // Process active character guessing
    if (ctx.chat.characterGameActive) {
        await guessCommand(ctx);
    }

    // Handle user's answer if there's an active game
    if (activeGames[chatId]) {
        if (activeGames[chatId].type === 'math') {
            await handleAnswer(ctx);
        } else if (activeGames[chatId].type === 'word') {
            await handleWordGuess(ctx);
        }
    }
}


function generateMathProblem() {
    const operations = ['+', '-', 'x'];
    const operation = operations[Math.floor(Math.random() * operations.length)];
    let num1, num2, answer;

    switch (operation) {
        case '+':
            num1 = Math.floor(Math.random() * 20) + 1;
            num2 = Math.floor(Math.random() * 20) + 1;
            answer = num1 + num2;
            break;
        case '-':
            num1 = Math.floor(Math.random() * 20) + 1;
            num2 = Math.floor(Math.random() * num1) + 1; // Ensure positive result
            answer = num1 - num2;
            break;
        case 'x':
            num1 = Math.floor(Math.random() * 10) + 1;
            num2 = Math.floor(Math.random() * 10) + 1;
            answer = num1 * num2;
            break;
    }

    return { num1, num2, operation, answer };
}

async function createMathImage(question) {
    const canvas = createCanvas(1000, 500);
    const ctx = canvas.getContext('2d');
    const bgImageUrl = 'https://files.catbox.moe/aws93i.png';

    try {
        // Load the background image only once and cache it
        if (!createMathImage.bgImage) {
            createMathImage.bgImage = await loadImage(bgImageUrl);
        }
        
        // Draw the background image onto the canvas
        ctx.drawImage(createMathImage.bgImage, 0, 0, canvas.width, canvas.height);

        // Set white color for the question text
        ctx.font = 'bold 40px Arial';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(question, canvas.width / 2, canvas.height / 2);

        // Convert the canvas to a buffer
        const buffer = canvas.toBuffer('image/png');

        // Prepare form data for uploading
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', buffer, { filename: 'math_question_with_bg.png' });

        // Upload to Catbox
        const response = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders()
        });

        return response.status === 200 && response.data.startsWith('https') ? response.data : null;
    } catch (error) {
        console.error('Error uploading to Catbox:', error);
        return null;
    }
}

async function sendMathGame(ctx) {
    const chatId = ctx.chat.id;
    
    const { num1, num2, operation, answer } = generateMathProblem();

    const question = `What is ${num1} ${operation} ${num2}?`;
    const imageUrl = await createMathImage(question);

    if (!imageUrl) {
        await ctx.reply("Sorry, there was an error creating the math game. Please try again later.");
        return;
    }

    activeGames[chatId] = {
        type: 'math',
        answer: answer.toString()
    };

    await ctx.replyWithPhoto(imageUrl, {
        caption: `Solve the math problem shown in the image.\n\nJust type your answer!`,
    });
}


async function handleAnswer(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const userAnswer = ctx.message?.text?.toLowerCase(); // Safely access message text

    if (!activeGames[chatId]) return;

    const game = activeGames[chatId];

    if (userAnswer === game.answer) {
        await updateUserBalance(userId, 40);
        await reactToMessage(chatId, ctx.message.message_id);
        await ctx.reply(`Correct, <a href="tg://user?id=${userId}">${ctx.from.first_name}</a>! You've earned 40 coins. 🎉`, { parse_mode: 'HTML' });
        delete activeGames[chatId];
    }
    // No response for incorrect answers
}

// Function to update user's balance
async function updateUserBalance(userId, amount) {
    const user = await destinationCollection.findOne({ id: userId });
    if (user) {
        const newBalance = (user.balance || 0) + amount;
        await destinationCollection.updateOne({ id: userId }, { $set: { balance: newBalance } });
    } else {
        await destinationCollection.insertOne({ id: userId, balance: amount });
    }
}

bot.command('mtop', async (ctx) => {
    try {
        // Fetch top 10 users from the database based on balance
        const topUsers = await destinationCollection
            .find({})
            .sort({ balance: -1 })
            .limit(10)
            .toArray();

        if (topUsers.length === 0) {
            await ctx.reply("No users found in the leaderboard.");
            return;
        }

        // Format leaderboard text
        let leaderboardText = '🏆 Top 10 Users by Coins 🏆\n\n';
        topUsers.forEach((user, index) => {
            const userId = user.id; // Assuming user object contains an `id` field
            leaderboardText += `${index + 1}. [${user.first_name || "User"}](tg://openmessage?user_id=${userId}) - ${user.balance} coins\n`;
        });

        // Send the image from the URL with leaderboard text as a caption
        await ctx.replyWithPhoto("https://envs.sh/A9X.jpg", { caption: leaderboardText, parse_mode: 'Markdown' });
    } catch (error) {
        console.error("Error fetching top users or sending image:", error);
        await ctx.reply("An error occurred while fetching the top users. Please try again later.");
    }
});


async function sendImage(ctx) {
    const chatId = ctx.chat.id;
    const allCharacters = await destinationCharCollection.find({}).toArray();

    // Initialize sentCharacters for the chat if not already done
    if (!sentCharacters[chatId]) {
        sentCharacters[chatId] = [];
    }

    // Reset sentCharacters if all have been sent
    if (sentCharacters[chatId].length === allCharacters.length) {
        sentCharacters[chatId] = [];
    }

    // Generate available characters based on the rarity
    const availableCharacters = allCharacters.filter(c =>
        c.id &&
        !sentCharacters[chatId].includes(c.id) &&
        c.rarity != null &&
        c.rarity !== '💸 Premium Edition'
    );

    if (availableCharacters.length === 0) {
        await ctx.reply("No characters available to send.");
        return;
    }

    // Calculate cumulative weights
    const cumulativeWeights = [];
    let cumulativeWeight = 0;
    for (const character of availableCharacters) {
        cumulativeWeight += RARITY_WEIGHTS[character.rarity] || 1;
        cumulativeWeights.push(cumulativeWeight);
    }

    const rand = Math.random() * cumulativeWeight;
    let selectedCharacter = availableCharacters.find((_, i) => rand <= cumulativeWeights[i]);

    // Generating a character code
    const characterCode = `#${Math.floor(Math.random() * 90000) + 10000}`;
    selectedCharacter.code = characterCode;

    // Send the character image
    const sentMessage = await ctx.replyWithPhoto(selectedCharacter.img_url, {
        caption: `✨ A Wild ${selectedCharacter.rarity} Character Appeared! ✨\n` +
                 `🔍 Use /guess to identify and add this mysterious character to your Harem!\n` +
                 `💫 Quick, before someone else claims them!`,
        parse_mode: 'Markdown'
    });

    // Store the last character and message ID
    lastCharacters[chatId] = selectedCharacter;
    lastCharacters[chatId].message_id = sentMessage.message_id;
    ctx.chat.characterGameActive = true; // Set game active
}

async function checkCharacter(ctx) {
    const characterId = ctx.message.text.split(' ')[1];

    if (!characterId) {
        await ctx.reply("❌ Please provide a character ID.");
        return;
    }

    // Fetch character information from the database
    const character = await destinationCharCollection.findOne({ id: characterId });
    
    if (!character) {
        await ctx.reply("❌ Character not found.");
        return;
    }

    // Fetch top 10 users who have this character
    const usersWithCharacter = await destinationCollection
        .find({ 'characters.id': characterId })
        .limit(10)
        .toArray();

    // Prepare user information for response
    const userNames = usersWithCharacter.map(user => {
        const userId = user.id; // Get the user ID
        const firstName = user.first_name || 'User'; // Get the user's first name
        return `[${firstName}](tg://openmessage?user_id=${userId})`; // Create a clickable user link
    });

    // Create message content
    const userList = userNames.length > 0 ? userNames.join('\n') : "No users found.";
    const infoMessage = `
    🔍 Character Information:
📛 𝗡𝗔𝗠𝗘: <b>${character.name}</b>
🌈 𝗔𝗡𝗜𝗠𝗘: <b>${character.anime}</b>
✨ 𝗥𝗔𝗥𝗜𝗧𝗬: <b>${character.rarity}</b>
    
🏆 𝗧𝗢𝗣 10 𝗨𝗦𝗘𝗥𝗦 𝗛𝗔𝗩𝗜𝗡𝗚 𝗧𝗛𝗜𝗦 𝗖𝗛𝗔𝗥𝗔𝗖𝗧𝗘𝗥:
${userList}
    `;

    // Send the character image first
    await ctx.replyWithPhoto(character.img_url, {
        caption: infoMessage,
        parse_mode: 'HTML' // Using HTML to parse the message
    });
}



const WRONG_FORMAT_TEXT = `🚫 Wrong format... Use the following format:

    /upload reply to photo character-name anime-name rarity-number

Where:
- reply to photo: Your image
- character-name: Name of the character
- anime-name: Name of the anime
- rarity-number: Rarity level (1-7)`;


async function findAvailableId() {
    const cursor = destinationCharCollection.find().sort({ id: 1 });
    const ids = await cursor.toArray().then(docs => docs.map(doc => doc.id));
    for (let i = 1; i <= Math.max(...ids.map(Number)) + 1; i++) {
        if (!ids.includes(String(i).padStart(2, '0'))) {
            return String(i).padStart(2, '0');
        }
    }
    return String(Math.max(...ids.map(Number)) + 1).padStart(2, '0');
}

async function uploadToCatbox(filePath) {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(filePath));

    try {
        const response = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders()
        });
        if (response.status === 200 && response.data.startsWith('https')) {
            return response.data;
        } else {
            throw new Error(`Error uploading to Catbox: ${response.data}`);
        }
    } catch (error) {
        throw new Error(`Error uploading to Catbox: ${error.message}`);
    }
}

bot.command('upload', async (ctx) => {
    if (!sudo_users.includes(ctx.from.id.toString())) {
        return ctx.reply('🚫 You do not have permission to use this command.');
    }

    const reply = ctx.message.reply_to_message;
    if (reply && (reply.photo || reply.document)) {
        const args = ctx.message.text.split(' ');
        if (args.length !== 4) {
            return ctx.reply(WRONG_FORMAT_TEXT);
        }

        const characterName = args[1].replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase());
        const anime = args[2].replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase());
        const rarity = parseInt(args[3]);

        if (!rarity_map[rarity]) {
            return ctx.reply("❌ Invalid rarity value. Please use a value between 1 and 7.");
        }

        const rarityText = rarity_map[rarity];
        const availableId = await findAvailableId();

        const character = {
            name: characterName,
            anime: anime,
            rarity: rarityText,
            id: availableId
        };

        const processingMessage = await ctx.reply("⏳ Processing your request...");
        
        try {
            const fileId = reply.photo ? reply.photo[reply.photo.length - 1].file_id : reply.document.file_id;
            const fileLink = await ctx.telegram.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const tempFilePath = `/tmp/${fileId}`;
            fs.writeFileSync(tempFilePath, response.data);

            const catboxUrl = await uploadToCatbox(tempFilePath);
            character.img_url = catboxUrl;

            await ctx.telegram.sendPhoto(CHARA_CHANNEL_ID, catboxUrl, {
                caption: `<b>Character Name:</b> ${character.name}\n<b>Anime Name:</b> ${character.anime}\n<b>Rarity:</b> ${character.rarity}\n<b>ID:</b> ${character.id}\n👤 Uploaded by <a href="tg://user?id=${ctx.from.id}">${ctx.from.first_name}</a>`,
                parse_mode: 'HTML'
            });

            await destinationCharCollection.insertOne(character);
            await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, "✅ Upload successful!");

            fs.unlinkSync(tempFilePath);
        } catch (error) {
            console.error(error);
            await ctx.telegram.editMessageText(ctx.chat.id, processingMessage.message_id, null, `❌ An error occurred: ${error.message}`);
        }
    } else {
        await ctx.reply("🚫 Please reply to a photo or document to upload.");
    }
});

const pendingGifts = {};

async function sendReply(ctx, text) {
    await ctx.reply(text);
}


// Gift command
bot.command('gift', async (ctx) => {
    const senderId = ctx.from.id;

    for (const key in pendingGifts) {
        if (key.startsWith(senderId)) {
            await sendReply(ctx, "You already have a gift processing. Please wait until it's done.");
            return;
        }
    }

    if (!ctx.message.reply_to_message) {
        await sendReply(ctx, "You need to reply to a user's message to gift a character!");
        return;
    }

    const receiverId = ctx.message.reply_to_message.from.id;

    if (senderId === receiverId) {
        await sendReply(ctx, "You can't gift a character to yourself!");
        return;
    }

    const commandParts = ctx.message.text.split(' ');
    if (commandParts.length !== 2) {
        await sendReply(ctx, "You need to provide a character ID!");
        return;
    }

    const characterId = commandParts[1];

    const sender = await destinationCollection.findOne({ id: senderId });
    const characterIndex = sender.characters.findIndex(character => character.id === characterId);

    if (characterIndex === -1) {
        await sendReply(ctx, "You don't have this character in your collection!");
        return;
    }

    pendingGifts[`${senderId}_${receiverId}`] = {
        character: sender.characters[characterIndex],
        processed: false
    };

    // Process the gift immediately without buttons
    const receiver = await destinationCollection.findOne({ id: receiverId });
    
    // Remove the character from the sender's collection (only one instance)
    sender.characters.splice(characterIndex, 1); // Removes the character at the found index
    await destinationCollection.updateOne({ id: senderId }, { $set: { characters: sender.characters } });

    if (receiver) {
        // Add the character to the receiver's collection
        receiver.characters.push(pendingGifts[`${senderId}_${receiverId}`].character);
        await destinationCollection.updateOne({ id: receiverId }, { $set: { characters: receiver.characters } });

        // Send success message
        await ctx.reply(`You have successfully gifted your character to ${ctx.message.reply_to_message.from.first_name}!`);
    } else {
        // Create a new user entry for the receiver if they don't exist
        await destinationCollection.create({
            id: receiverId,
            username: ctx.message.reply_to_message.from.username,
            first_name: ctx.message.reply_to_message.from.first_name,
            characters: [pendingGifts[`${senderId}_${receiverId}`].character]
        });

        // Send success message
        await ctx.reply(`You have successfully gifted your character to ${ctx.message.reply_to_message.from.first_name}!`);
    }

    // Clear the pending gift
    delete pendingGifts[`${senderId}_${receiverId}`];
});

// Note: No need for the confirmation and cancellation actions since we've removed the buttons

const words = [
    "dog", "cat", "bird", "lion", "tiger", "elephant", "monkey", "zebra",
    "apple", "banana", "grape", "honey", "juice", 
    "kite", "mountain", "ocean", "river", "sun", "tree", 
    "umbrella", "water", "car", "garden", "hat", "island", 
    "lemon", "orange", "road", "stone", "train", 
    "vase", "window", "yarn", "zoo", "ant", "eagle", "fox", 
    "goat", "hippo", "iguana", "jellyfish", "kangaroo", 
    "lemur", "meerkat", "newt", "penguin", "rabbit", 
    "seal", "turtle", "whale", "yak", "wolf", "panther", 
    "dolphin", "frog", "horse", "koala", "ostrich", "peacock", 
    "reindeer", "shark", "toucan", "viper", "walrus", 
    "zebra", "baboon", "cheetah", "deer", "elephant", 
    "flamingo", "gorilla", "hamster", "iguana", "jaguar", 
    "koala", "lemur", "mongoose", "narwhal", "owl", 
    "parrot", "quetzal", "raven", "sloth", "toucan", 
    "vulture", "zebra", "alligator", "buffalo", "dolphin", 
    "flamingo", "giraffe", "hummingbird", "iguana", "jackal", 
    "kangaroo", "lemur", "macaw", "narwhal", "parrot", 
    "quail", "reindeer", "sloth", "toucan", "wallaby", 
    "xenops", "yak", "zebra", "alligator", "baboon", 
    "camel", "donkey", "falcon", "hippo", "jackrabbit", 
    "koala", "mongoose", "owl", "raven", "seagull", 
    "tapir", "viper", "wombat", "xenops", "yak", "zebra", 
    "rain", "storm", "fog", "wind", "sunshine", 
    "rainbow", "hurricane", "snow", "dew", "frost", 
    "clear", "gust", "overcast", "sunny", "flood", 
    "swelter", "stormy", "calm", "cold", "hot", "cool", 
    "mild", "refreshing", "warm", "scorching", "boiling", 
    "foggy", "snowy", "windy", "rainy", "sunset", "dusk", 
    "afternoon", "morning", "midnight", "midday", 
    "starlight", "moonlight", "weekday", "weekend", "year", 
    "century", "millennium", "moment", "minute", "hour", 
    "day", "week", "year", "era", "epoch", "event", 
    "circumstance", "condition", "case", "instance", 
    "background", "location", "place", "spot", "city", 
    "town", "village", "street", "road", "path", 
    "trail", "intersection", "block", "house", "apartment", 
    "office", "store", "shop", "market", "mall", 
    "hotel", "restaurant", "bar", "club", "theater", 
    "museum", "stadium", "park", "school", "college", 
    "hospital", "pharmacy", "bank", "library", "church", 
    "temple", "mosque", "shrine", "palace", "castle", 
    "monument", "statue", "tower", "factory", "warehouse", 
    "farm", "ranch", "workshop", "studio"
];




const bgImageUrl = 'https://files.catbox.moe/aws93i.png';  // Background image URL

function hideLetters(word) {
    // Replace some letters with underscores (e.g., every other letter)
    return word
        .split('')
        .map((char, index) => (index % 2 === 0 ? '_' : char))
        .join(' ');  // Add a space between each letter
}

// Cache the background image
let cachedBgImage = null;

async function sendWordGameImage(ctx) {
    const chatId = ctx.chat.id;
    const word = words[Math.floor(Math.random() * words.length)];
    const hiddenWord = hideLetters(word);

    const canvas = createCanvas(1000, 500);
    const context = canvas.getContext('2d');

    try {
        // Load background image if not cached
        if (!cachedBgImage) {
            cachedBgImage = await loadImage(bgImageUrl);
        }
        context.drawImage(cachedBgImage, 0, 0, canvas.width, canvas.height);

        // Set text properties
        context.font = 'bold 60px Arial';
        context.fillStyle = '#FFFFFF';
        context.textAlign = 'center';
        context.textBaseline = 'middle';

        // Draw hidden word with spaces in the center of the canvas
        context.fillText(hiddenWord, canvas.width / 2, canvas.height / 2);

        // Convert the canvas to a buffer and upload to Catbox
        const buffer = canvas.toBuffer('image/png');
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', buffer, { filename: 'word_game.png' });

        const response = await axios.post('https://catbox.moe/user/api.php', form, { headers: form.getHeaders() });

        if (response.status === 200 && response.data.startsWith('https')) {
            await ctx.replyWithPhoto(response.data, { caption: "Guess the word!" });
            activeGames[chatId] = { type: 'word', answer: word };
        } else {
            throw new Error('Failed to upload the image to Catbox');
        }
    } catch (error) {
        console.error('Error generating word game image:', error);
        await ctx.reply("There was an error creating the word game. Please try again.");
    }
}

// Hide letters in the word by replacing a few characters with underscores
function hideLetters(word) {
    const hideCount = Math.floor(word.length / 2);
    const hiddenIndices = new Set();
    while (hiddenIndices.size < hideCount) {
        hiddenIndices.add(Math.floor(Math.random() * word.length));
    }
    return [...word].map((char, idx) => (hiddenIndices.has(idx) ? '_' : char)).join('');
}

// Handle user guess
async function handleWordGuess(ctx) {
    const chatId = ctx.chat.id;
    const userAnswer = ctx.message?.text?.toLowerCase();

    if (!activeGames[chatId] || activeGames[chatId].type !== 'word') return;

    const game = activeGames[chatId];

    if (userAnswer === game.answer) {
        await updateUserBalance(ctx.from.id, 40);  // Reward user with 40 coins
        await ctx.reply(`Correct, ${ctx.from.first_name}! You've earned 40 coins. 🎉`);
        delete activeGames[chatId];  // End the game
    } 
}


// Middleware for database access
bot.use((ctx, next) => {
    ctx.db = {
        userTotalsCollection,
        groupUserTotalsCollection,
        topGlobalGroupsCollection,
        pmUsersCollection,
        destinationCollection,
        destinationCharCollection,
        collection: destinationCharCollection
    };
    return next();
});

// Command and action handlers
bot.command(['guess', 'protecc', 'collect', 'grab', 'hunt'], guessCommand);
bot.command('fav', favCommand);
bot.command('now', nowCommand);
bot.command(['harem', 'collection'], (ctx) => harem(ctx));
bot.action(/^harem:/, haremCallback);

// Top-related commands
bot.command('ctop', ctop);
bot.command('TopGroups', globalLeaderboard);
bot.command('stats', stats);
bot.command('list', sendUsersDocument);
bot.command('groups', sendGroupsDocument);
bot.command('top', handleTopCommand);

// Balance-related commands
bot.command(['balance', 'cloins', 'mybalance', 'mycoins'], balance);
bot.command(['pay', 'coinpay', 'paycoin', 'coinspay', 'paycoins'], pay);
bot.command(['dailyreward', 'dailytoken', 'daily', 'bonus', 'reward'], dailyReward);

// chk.js
bot.command('check', checkCharacter);

// Start command
bot.command('start', start);

// Inline query handling
bot.on('inline_query', (ctx) => inlineQuery(ctx)); 

// Handle all messages
bot.on('message', async (ctx) => {
    if (ctx.chat.characterGameActive) {
        await none(ctx);
    } else {
        await messageCounter(ctx); // Handle other messages
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); // Serve index.html from the same directory
});

// Start the Express server with the hardcoded port
app.listen(port, () => {
    console.log(`Web server running on port ${port}`);
});

// Start the bot and other configurations
importModules().then(() => {
    connectToDatabase();
    bot.launch();
    console.log('Bot is running!');
}).catch(error => {
    console.error('Failed to start the bot:', error);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

exports = {
    bot
}
  
