const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const request = require('request'); // For callSendAPI
const { MongoClient } = require('mongodb'); // MongoDB driver

// Initialize Express app
const app = express();
app.use(bodyParser.json());

// Facebook Messenger configuration
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// MongoDB Configuration
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'gagmes';
const COLLECTION_NAME = 'subscribers';

let dbClient;
let db;

// Function to connect to MongoDB
async function connectToDatabase() {
    if (db && dbClient && dbClient.topology && dbClient.topology.isConnected()) {
        return db;
    }
    try {
        dbClient = new MongoClient(MONGODB_URI);
        await dbClient.connect();
        db = dbClient.db(DB_NAME);
        console.log("Successfully connected to MongoDB.");
        return db;
    } catch (error) {
        console.error("Could not connect to MongoDB:", error);
        throw error;
    }
}

// Item definitions for filtering messages from the external WebSocket
const RARE_ITEMS = { // display_names of items considered rare
    normal: ['Basic Sprinkler', 'Advanced Sprinkler', 'Grape', 'Mushroom', 'Pepper', 'Cacao', 'Legendary Egg', 'Mythical Egg', 'Bee Egg'],
    priority: ['Beanstalk', 'Ember Lily', 'Sugar Apple', 'Feijoa', 'Loquat', 'Godly Sprinkler', 'Master Sprinkler', 'Bug Egg']
};
const SUMMER_SEEDS = ['Cauliflower', 'Green Apple', 'Avocado', 'Banana', 'Pineapple', 'Bell Pepper', 'Prickly pear', 'Kiwi', 'Feijoa', 'Loquat']; // display_names

function isRareItem(itemName) {
    return RARE_ITEMS.normal.includes(itemName) || RARE_ITEMS.priority.includes(itemName);
}

// Local cache for current stock information (from external WebSocket)
let currentStockCache = {
    latestRareItem: null,    // Will store the full item object: { display_name, quantity, item_id, ... }
    latestSummerSeed: null // Will store the full item object
};

class BotLogger {
    constructor() { /* ... */ }
    log(type, message, data = {}) { const timestamp = new Date().toISOString(); const logEntry = { timestamp, type, message, ...data }; console.log(JSON.stringify(logEntry)); }
}
const logger = new BotLogger();

// Facebook Messenger specific functions
async function sendTextMessage(senderId, text) {
    logger.log('info', `Attempting to send message to Facebook User ${senderId}: "${text}"`);
    const messageData = { messaging_type: 'RESPONSE', recipient: { id: senderId }, message: { text: text } };
    try {
        await callSendAPI(messageData);
    } catch (error) {
        logger.log('error', `Error in sendTextMessage for Facebook User ${senderId}:`, { error: error.message, stack: error.stack });
    }
}

function callSendAPI(messageData) {
    return new Promise((resolve, reject) => {
        request({
            uri: 'https://graph.facebook.com/v17.0/me/messages',
            qs: { access_token: PAGE_ACCESS_TOKEN },
            method: 'POST',
            json: messageData
        }, (error, response, body) => {
            if (!error && response.statusCode >= 200 && response.statusCode < 300) {
                logger.log('info', 'Message sent successfully to Facebook API', { recipient: messageData.recipient.id });
                resolve(body);
            } else {
                const errorDetail = { message: error ? error.message : "Unknown error", statusCode: response ? response.statusCode : "N/A", body };
                logger.log('error', 'Error sending message via Facebook API:', errorDetail);
                reject(error || new Error(`Failed to send message, status: ${response ? response.statusCode : 'N/A'}`));
            }
        });
    });
}

// WebSocket connection to EXTERNAL game update service
const ws = new WebSocket('wss://websocket.joshlei.com/growagarden/?user_id=1377463641078497401');

ws.on('open', () => {
    logger.log('info', 'EXTERNAL WebSocket connection established.');
});

ws.on('message', async (data) => {
    const rawDataString = data.toString();
    logger.log('info', 'RAW EXTERNAL WebSocket Data Received:', { shortData: rawDataString.substring(0, 200) + "..." }); // Log ALL data (shortened for brevity here)

    try {
        const fullStockUpdate = JSON.parse(rawDataString);

        let foundRareItemForBroadcast = null;
        let foundSummerSeedForBroadcast = null;

        const stockKeysToCheck = ['seed_stock', 'gear_stock', 'egg_stock', 'cosmetic_stock', 'eventshop_stock'];

        for (const key of stockKeysToCheck) {
            if (Array.isArray(fullStockUpdate[key])) {
                for (const item of fullStockUpdate[key]) {
                    if (item && item.display_name) {
                        // Check for Rare Items
                        if (isRareItem(item.display_name)) {
                            logger.log('info', 'Found Rare Item in WebSocket data:', { name: item.display_name, qty: item.quantity });
                            currentStockCache.latestRareItem = { ...item }; // Cache it
                            if (!foundRareItemForBroadcast) { // Broadcast only the first one found in this update
                                foundRareItemForBroadcast = item;
                            }
                        }
                        // Check for Summer Seeds (only in seed_stock)
                        if (key === 'seed_stock' && SUMMER_SEEDS.includes(item.display_name)) {
                            logger.log('info', 'Found Summer Seed in WebSocket data:', { name: item.display_name, qty: item.quantity });
                            currentStockCache.latestSummerSeed = { ...item }; // Cache it
                             if (!foundSummerSeedForBroadcast) { // Broadcast only the first one found in this update
                                foundSummerSeedForBroadcast = item;
                            }
                        }
                    }
                }
            }
        }
        
        if (foundRareItemForBroadcast) {
            const notification = `🎯 Rare Item Alert!\n${foundRareItemForBroadcast.display_name} is now available!\nQuantity: ${foundRareItemForBroadcast.quantity}`;
            await broadcastToSubscribers(notification, 'rare_item_update');
        }
        
        if (foundSummerSeedForBroadcast) {
             const notification = `🌞 Summer Seed Update!\n${foundSummerSeedForBroadcast.display_name} seeds are available!\nQuantity: ${foundSummerSeedForBroadcast.quantity}`;
             await broadcastToSubscribers(notification, 'summer_seed_update');
        }

        if (!foundRareItemForBroadcast && !foundSummerSeedForBroadcast) {
            logger.log('info', 'External WebSocket message processed, but no new rare items or summer seeds triggered an immediate broadcast from this specific update.');
        }

    } catch (error) {
        logger.log('error', 'Error processing EXTERNAL WebSocket message:', { error: error.message, dataReceived: rawDataString.substring(0, 200) + "...", stack: error.stack });
    }
});

ws.on('error', (error) => {
    logger.log('error', 'EXTERNAL WebSocket error:', { error: error.message, stack: error.stack });
});

ws.on('close', (code, reason) => {
    logger.log('info', 'EXTERNAL WebSocket connection closed.', { code, reason: reason.toString() });
});

// --- Function to Send Current Stock Summary (from cache) to a Facebook User ---
async function sendCurrentStockSummary(senderId) {
    logger.log('info', `Sending current stock summary (from cache) to Facebook User ${senderId}`);
    let summaryParts = [];

    const rareItem = currentStockCache.latestRareItem;
    if (rareItem && rareItem.display_name) {
        summaryParts.push(`Latest Rare Item (from cache):\n${rareItem.display_name}\nQuantity: ${rareItem.quantity}`);
    }

    const summerItem = currentStockCache.latestSummerSeed;
    if (summerItem && summerItem.display_name) {
        summaryParts.push(`Latest Summer Seed (from cache):\n${summerItem.display_name}\nQuantity: ${summerItem.quantity}`);
    }

    if (summaryParts.length > 0) {
        const fullMessage = "Here's the latest stock information I have (this is from my cache and updates when new items appear in the game feed):\n\n" + summaryParts.join("\n\n---\n\n");
        await sendTextMessage(senderId, fullMessage);
    } else {
        await sendTextMessage(senderId, "My cache is currently empty for rare items/summer seeds. You'll be notified when new ones appear in the game feed!");
    }
}

// --- Subscriber Functions (for Facebook Users in MongoDB) ---
async function subscribeUser(senderId) {
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const existingSubscriber = await subscribersCollection.findOne({ senderId: senderId });

        if (!existingSubscriber) {
            await subscribersCollection.insertOne({ senderId: senderId, subscribedAt: new Date() });
            logger.log('info', `Facebook User ${senderId} subscribed.`);
            await sendTextMessage(senderId, "You've been subscribed to notifications!");
            await sendCurrentStockSummary(senderId);
        } else {
            logger.log('info', `Facebook User ${senderId} is already subscribed.`);
            await sendTextMessage(senderId, "You're already subscribed! Here's the latest stock info I have from my cache:");
            await sendCurrentStockSummary(senderId);
        }
    } catch (error) {
        logger.log('error', `Error in subscribeUser for Facebook User ${senderId}:`, { error: error.message, stack: error.stack });
        await sendTextMessage(senderId, "Sorry, there was an error subscribing you. Please try again later.");
    }
}

async function unsubscribeUser(senderId) {
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const result = await subscribersCollection.deleteOne({ senderId: senderId });

        if (result.deletedCount > 0) {
            logger.log('info', `Facebook User ${senderId} unsubscribed.`);
            await sendTextMessage(senderId, "You've been unsubscribed from notifications.");
        } else {
            logger.log('info', `Facebook User ${senderId} was not subscribed or already unsubscribed.`);
            await sendTextMessage(senderId, "You weren't subscribed, so no action was taken.");
        }
    } catch (error) {
        logger.log('error', `Error in unsubscribeUser for Facebook User ${senderId}:`, { error: error.message, stack: error.stack });
        await sendTextMessage(senderId, "Sorry, there was an error unsubscribing you. Please try again later.");
    }
}

async function broadcastToSubscribers(notificationMessage, type) {
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const allSubscribers = await subscribersCollection.find({}).toArray();

        logger.log('info', `Broadcasting (type: ${type}): "${notificationMessage}" to ${allSubscribers.length} subscribed Facebook users.`);
        if (allSubscribers.length === 0) {
            logger.log('info', 'No Facebook subscribers to broadcast to.');
            return;
        }

        const sendPromises = allSubscribers.map(subscriber =>
            sendTextMessage(subscriber.senderId, notificationMessage)
        );
        
        const results = await Promise.allSettled(sendPromises);
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.log('error', `Failed to broadcast to Facebook User ${allSubscribers[index].senderId}:`, { error: result.reason ? result.reason.message : "Unknown reason" });
            }
        });
        logger.log('info', 'Broadcast to Facebook users completed.');

    } catch (error) {
        logger.log('error', 'Error in broadcastToSubscribers (to Facebook users):', { error: error.message, stack: error.stack });
    }
}

// --- Express routes for Facebook Messenger webhook ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            logger.log('info',"Facebook WEBHOOK_VERIFIED - Sending challenge back");
            res.status(200).send(challenge);
        } else {
            logger.log('error',"Facebook Webhook verification failed. Mode or token mismatch.");
            res.sendStatus(403);
        }
    } else {
        logger.log('warn', "Missing mode or token in Facebook GET /webhook request");
        res.sendStatus(400);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        const processingPromises = body.entry.map(async (entry) => {
            if (entry.messaging && entry.messaging[0]) {
                const webhookEvent = entry.messaging[0];
                const senderId = webhookEvent.sender.id;
                if (webhookEvent.message) {
                    await handleMessage(senderId, webhookEvent.message);
                } else if (webhookEvent.postback) {
                    logger.log('info', 'Received Facebook postback (not handled)', { senderId, postback: webhookEvent.postback });
                } else {
                    logger.log('info', 'Received unhandled Facebook webhook event type', { senderId, event: webhookEvent });
                }
            } else {
                logger.log('warn', 'Received Facebook entry with no messaging array or empty messaging array', { entry });
            }
        });
        try {
            await Promise.allSettled(processingPromises);
        } catch (error) {
            logger.log('error', 'Error processing Facebook webhook entries', { error: error.message, stack: error.stack });
        }
        res.status(200).send('EVENT_RECEIVED');
    } else {
        logger.log('warn', "POST /webhook not from a Facebook page subscription", { object: body.object });
        res.sendStatus(404);
    }
});

// --- Message handling (for messages from Facebook Users) ---
async function handleMessage(senderId, message) {
    if (message.text) {
        const text = message.text.toLowerCase().trim();
        logger.log('info', `Handling Facebook message from ${senderId}: "${text}"`);
        try {
            if (text === 'subscribe') {
                await subscribeUser(senderId);
            } else if (text === 'unsubscribe') {
                await unsubscribeUser(senderId);
            } else if (text === 'help') {
                await sendTextMessage(senderId, 'Available commands:\nsubscribe - Get notifications\nunsubscribe - Stop notifications\nhelp - Show this message');
            } else {
                await sendTextMessage(senderId, "Sorry, I didn't understand that. Type 'help' for commands.");
                logger.log('info', `Unrecognized command from Facebook User ${senderId}: "${text}"`);
            }
        } catch (error) {
            logger.log('error', `Error in handleMessage for Facebook User ${senderId} processing "${text}":`, { error: error.message, stack: error.stack });
            try {
                await sendTextMessage(senderId, "Sorry, I encountered an error processing your request. Please try again.");
            } catch (sendError) {
                logger.log('error', `Failed to send error message to Facebook User ${senderId}:`, { error: sendError.message });
            }
        }
    } else if (message.attachments) {
        logger.log('info', `Received attachment from Facebook User ${senderId} (not handled).`);
        await sendTextMessage(senderId, "Thanks for the attachment! I can't process those yet.");
    } else {
        logger.log('info', `Received non-text, non-attachment message from Facebook User ${senderId} (not handled).`, { message });
    }
}

// Export the app for Vercel
module.exports = app;

// Optional: If running locally for testing
/*
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    try {
        await connectToDatabase(); // Connect to DB when server starts locally
        console.log("Local server connected to MongoDB.");
    } catch (e) {
        console.error("Local server failed to connect to MongoDB on startup:", e);
    }
});
*/