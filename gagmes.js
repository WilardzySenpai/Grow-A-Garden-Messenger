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

// Function to connect to MongoDB and initialize db and dbClient
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

// Channel and topic configuration (from external WebSocket)
const TOPICS = {
    WEATHER: 9,
    EGGS: 8,
    EVENTS: 2,
    COSMETICS: 3,
    SHOP: 4,
    RARE: 632, // Example: This topic ID comes from the external WebSocket
    SUMMER_EVENT: 5939, // Example: This topic ID comes from the external WebSocket
};

// Item definitions for filtering messages from the external WebSocket
const RARE_ITEMS = {
    normal: ['Basic Sprinkler', 'Advanced Sprinkler', 'Grape', 'Mushroom', 'Pepper', 'Cacao', 'Legendary Egg', 'Mythical Egg', 'Bee Egg'],
    priority: ['Beanstalk', 'Ember Lily', 'Sugar Apple', 'Feijoa', 'Loquat', 'Godly Sprinkler', 'Master Sprinkler', 'Bug Egg']
};
const SUMMER_SEEDS = ['Cauliflower', 'Green Apple', 'Avocado', 'Banana', 'Pineapple', 'Bell Pepper', 'Prickly pear', 'Kiwi', 'Feijoa', 'Loquat'];

function isRareItem(itemName) { return RARE_ITEMS.normal.includes(itemName) || RARE_ITEMS.priority.includes(itemName); }

// Local cache for current stock information (from external WebSocket)
let currentStockCache = {
    [TOPICS.RARE]: null,
    [TOPICS.SUMMER_EVENT]: null
};

class BotLogger {
    constructor() { this.statsInterval = null; this.stats = { messagesSent: 0, messagesQueued: 0, errors: 0, rateLimitHits: 0, lastResetTime: Date.now(), avgQueueWaitTime: 0, totalWaitTime: 0 }; }
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
                logger.log('info', 'Message sent successfully to Facebook API', { recipient: messageData.recipient.id, body: body || "No body" });
                resolve(body);
            } else {
                const errorDetail = {
                    message: error ? error.message : "Unknown error",
                    statusCode: response ? response.statusCode : "N/A",
                    body: body
                };
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
    logger.log('info', 'RAW EXTERNAL WebSocket Data Received:', { rawData: rawDataString }); // Log ALL data

    try {
        const message = JSON.parse(rawDataString); // message from external WebSocket
        const { topic, content } = message;
        logger.log('info', 'Parsed EXTERNAL WebSocket message', { topic, itemName: content ? content.itemName : 'N/A' });

        let notificationForFacebookUser;
        let notificationTypeForLogging;

        // Update cache with data from external WebSocket
        if (content) {
            if (topic === TOPICS.RARE && content.itemName && isRareItem(content.itemName)) {
                currentStockCache[TOPICS.RARE] = content;
                logger.log('info', 'Updated RARE item cache from EXTERNAL WebSocket', { item: content.itemName });
            } else if (topic === TOPICS.SUMMER_EVENT && content.itemName && SUMMER_SEEDS.includes(content.itemName)) {
                currentStockCache[TOPICS.SUMMER_EVENT] = content;
                logger.log('info', 'Updated SUMMER_EVENT item cache from EXTERNAL WebSocket', { item: content.itemName });
            }
        }

        // Determine if this external WebSocket message should be broadcast to Facebook users
        switch (topic) {
            case TOPICS.RARE:
                if (content && content.itemName && isRareItem(content.itemName)) {
                    notificationForFacebookUser = `🎯 Rare Item Alert!\n${content.itemName} is now available!\nQuantity: ${content.quantity}\nPrice: ${content.price}`;
                    notificationTypeForLogging = 'rare_items';
                }
                break;
            case TOPICS.SUMMER_EVENT:
                if (content && content.itemName && SUMMER_SEEDS.includes(content.itemName)) {
                    notificationForFacebookUser = `🌞 Summer Event Update!\n${content.itemName} seeds are available!\nQuantity: ${content.quantity}\nPrice: ${content.price}`;
                    notificationTypeForLogging = 'summer_event';
                }
                break;
        }

        if (notificationForFacebookUser) {
            logger.log('info', `EXTERNAL WebSocket event triggered broadcast: ${notificationTypeForLogging}`);
            await broadcastToSubscribers(notificationForFacebookUser, notificationTypeForLogging);
        } else {
            logger.log('info', 'EXTERNAL WebSocket message received, but no broadcast triggered (topic/item not matching criteria).', {topic, itemName: content ? content.itemName : 'N/A'});
        }
    } catch (error) {
        logger.log('error', 'Error processing EXTERNAL WebSocket message:', { error: error.message, dataReceived: rawDataString, stack: error.stack });
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

    const rareItem = currentStockCache[TOPICS.RARE];
    if (rareItem && rareItem.itemName) {
        summaryParts.push(`Latest Rare Item (from cache):\n${rareItem.itemName}\nQuantity: ${rareItem.quantity}\nPrice: ${rareItem.price}`);
    }

    const summerItem = currentStockCache[TOPICS.SUMMER_EVENT];
    if (summerItem && summerItem.itemName) {
        summaryParts.push(`Latest Summer Event Item (from cache):\n${summerItem.itemName}\nQuantity: ${summerItem.quantity}\nPrice: ${summerItem.price}`);
    }

    if (summaryParts.length > 0) {
        const fullMessage = "Here's the latest stock information I have (this is from my cache and updates when new items appear):\n\n" + summaryParts.join("\n\n---\n\n");
        await sendTextMessage(senderId, fullMessage);
    } else {
        await sendTextMessage(senderId, "I don't have any specific stock updates in my cache right now, but you'll be notified of new items as they come from the game feed!");
    }
}

// --- Subscriber Functions (for Facebook Users in MongoDB) ---
async function subscribeUser(senderId) { // senderId is Facebook User ID
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const existingSubscriber = await subscribersCollection.findOne({ senderId: senderId });

        if (!existingSubscriber) {
            await subscribersCollection.insertOne({ senderId: senderId, subscribedAt: new Date() });
            logger.log('info', `Facebook User ${senderId} subscribed.`);
            await sendTextMessage(senderId, "You've been subscribed to notifications!");
            await sendCurrentStockSummary(senderId); // Send current cached stock info
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

async function unsubscribeUser(senderId) { // senderId is Facebook User ID
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

async function broadcastToSubscribers(notificationMessage, type) { // type is for logging
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const allSubscribers = await subscribersCollection.find({}).toArray(); // These are Facebook User IDs

        logger.log('info', `Broadcasting (type: ${type}): "${notificationMessage}" to ${allSubscribers.length} subscribed Facebook users.`);
        if (allSubscribers.length === 0) {
            logger.log('info', 'No Facebook subscribers to broadcast to.');
            return;
        }

        const sendPromises = allSubscribers.map(subscriber =>
            sendTextMessage(subscriber.senderId, notificationMessage) // Sending to Facebook User
        );
        
        const results = await Promise.allSettled(sendPromises);

        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.log('error', `Failed to broadcast to Facebook User ${allSubscribers[index].senderId}:`, { error: result.reason.message });
            }
        });
        logger.log('info', 'Broadcast to Facebook users completed.');

    } catch (error) {
        logger.log('error', 'Error in broadcastToSubscribers (to Facebook users):', { error: error.message, stack: error.stack });
    }
}

// --- Express routes for Facebook Messenger webhook ---
app.get('/webhook', (req, res) => { // Facebook sends GET for verification
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

app.post('/webhook', async (req, res) => { // Facebook sends POST for messages from users
    const body = req.body;
    if (body.object === 'page') {
        const processingPromises = body.entry.map(async (entry) => {
            if (entry.messaging && entry.messaging[0]) {
                const webhookEvent = entry.messaging[0]; // Event from a Facebook User
                const senderId = webhookEvent.sender.id; // Facebook User's ID
                if (webhookEvent.message) {
                    await handleMessage(senderId, webhookEvent.message); // Handle Facebook User's message
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
        res.status(200).send('EVENT_RECEIVED'); // Acknowledge receipt to Facebook
    } else {
        logger.log('warn', "POST /webhook not from a Facebook page subscription", { object: body.object });
        res.sendStatus(404);
    }
});

// --- Message handling (for messages from Facebook Users) ---
async function handleMessage(senderId, message) { // senderId is Facebook User ID
    if (message.text) {
        const text = message.text.toLowerCase().trim();
        logger.log('info', `Handling Facebook message from ${senderId}: "${text}"`);

        try {
            if (text === 'subscribe') {
                await subscribeUser(senderId);
            } else if (text === 'unsubscribe') {
                await unsubscribeUser(senderId);
            } else if (text === 'help') {
                await sendTextMessage(senderId, 'Available commands:\nsubscribe - Subscribe to notifications\nunsubscribe - Stop notifications\nhelp - Show this message');
            } else {
                // Default response to Facebook user for unrecognized command
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

// Optional: If running locally for testing, uncomment:
/*
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    try {
        await connectToDatabase();
        console.log("Local server connected to MongoDB.");
    } catch (e) {
        console.error("Local server failed to connect to MongoDB on startup:", e);
    }
});
*/