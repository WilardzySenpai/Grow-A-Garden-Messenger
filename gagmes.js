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
const MONGODB_URI = process.env.MONGODB_URI; // mongodb+srv://chi:chichi3819@cluster0.xffuh81.mongodb.net/gagmes
const DB_NAME = 'gagmes'; // Or extract from URI if needed, but 'gagmes' is specified
const COLLECTION_NAME = 'subscribers';

let dbClient;
let db;

// Function to connect to MongoDB and initialize db and dbClient
// Call this at the start of functions that need DB access, or manage a persistent connection.
// For Vercel, establishing connection per request (with caching) is common.
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
        // If connection fails, subsequent DB operations will fail.
        // Consider how to handle this - maybe retry or log critical error.
        throw error; // Propagate error
    }
}


// Channel and topic configuration
const TOPICS = {
    WEATHER: 9,
    EGGS: 8,
    EVENTS: 2,
    COSMETICS: 3,
    SHOP: 4,
    RARE: 632,
    SUMMER_EVENT: 5939,
};

// Rare items configuration
const RARE_ITEMS = {
    normal: ['Basic Sprinkler', 'Advanced Sprinkler', 'Grape', 'Mushroom', 'Pepper', 'Cacao', 'Legendary Egg', 'Mythical Egg', 'Bee Egg'],
    priority: ['Beanstalk', 'Ember Lily', 'Sugar Apple', 'Feijoa', 'Loquat', 'Godly Sprinkler', 'Master Sprinkler', 'Bug Egg']
};
const SUMMER_SEEDS = ['Cauliflower', 'Green Apple', 'Avocado', 'Banana', 'Pineapple', 'Bell Pepper', 'Prickly pear', 'Kiwi', 'Feijoa', 'Loquat'];

function isRareItem(itemName) { return RARE_ITEMS.normal.includes(itemName) || RARE_ITEMS.priority.includes(itemName); }
// function isPriorityRareItem(itemName) { return RARE_ITEMS.priority.includes(itemName); } // Not used currently

class BotLogger {
    constructor() { this.statsInterval = null; this.stats = { messagesSent: 0, messagesQueued: 0, errors: 0, rateLimitHits: 0, lastResetTime: Date.now(), avgQueueWaitTime: 0, totalWaitTime: 0 }; /*this.startStatsLogging();*/ } // Removed auto-start for brevity
    log(type, message, data = {}) { const timestamp = new Date().toISOString(); const logEntry = { timestamp, type, message, ...data }; console.log(JSON.stringify(logEntry)); }
    // logStats() { this.log('stats', 'Performance stats', this.stats); this.resetStats(); }
    // resetStats() { this.stats = { messagesSent: 0, messagesQueued: 0, errors: 0, rateLimitHits: 0, lastResetTime: Date.now(), avgQueueWaitTime: 0, totalWaitTime: 0 }; }
}
const logger = new BotLogger();

// Facebook Messenger specific functions (must be async due to potential DB ops or if callSendAPI becomes async)
async function sendTextMessage(senderId, text) {
    logger.log('info', `Attempting to send message to ${senderId}: "${text}"`);
    const messageData = { messaging_type: 'RESPONSE', recipient: { id: senderId }, message: { text: text } };
    try {
        await callSendAPI(messageData);
    } catch (error) {
        logger.log('error', `Error in sendTextMessage for ${senderId}:`, { error: error.message, stack: error.stack });
    }
}

// Promisify callSendAPI
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

// WebSocket connection for game updates
const ws = new WebSocket('wss://websocket.joshlei.com/growagarden/?user_id=1377463641078497401'); // Ensure this doesn't crash if it can't connect immediately

ws.on('open', () => {
    logger.log('info', 'WebSocket connection established.');
});

ws.on('message', async (data) => {
    try {
        const messageString = data.toString(); // Ensure data is a string
        const message = JSON.parse(messageString);
        const { topic, content } = message;
        logger.log('info', 'Received WebSocket message', { topic, itemName: content.itemName });

        let notification;
        let notificationType;

        switch (topic) {
            case TOPICS.RARE:
                if (content && content.itemName && isRareItem(content.itemName)) {
                    notification = `🎯 Rare Item Alert!\n${content.itemName} is now available!\nQuantity: ${content.quantity}\nPrice: ${content.price}`;
                    notificationType = 'rare_items';
                }
                break;
            case TOPICS.SUMMER_EVENT:
                if (content && content.itemName && SUMMER_SEEDS.includes(content.itemName)) {
                    notification = `🌞 Summer Event Update!\n${content.itemName} seeds are available!\nQuantity: ${content.quantity}\nPrice: ${content.price}`;
                    notificationType = 'summer_event';
                }
                break;
            // Add other topics as needed
        }

        if (notification) {
            await broadcastToSubscribers(notification, notificationType);
        }
    } catch (error) {
        logger.log('error', 'Error processing WebSocket message:', { error: error.message, dataReceived: data.toString(), stack: error.stack });
    }
});

ws.on('error', (error) => {
    logger.log('error', 'WebSocket error:', { error: error.message, stack: error.stack });
});

ws.on('close', (code, reason) => {
    logger.log('info', 'WebSocket connection closed.', { code, reason: reason.toString() });
    // Consider reconnection logic if necessary for your application
});


// --- Subscriber Functions (MongoDB based) ---
async function subscribeUser(senderId) {
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const existingSubscriber = await subscribersCollection.findOne({ senderId: senderId });

        if (!existingSubscriber) {
            await subscribersCollection.insertOne({ senderId: senderId, subscribedAt: new Date() });
            logger.log('info', `User ${senderId} subscribed.`);
            await sendTextMessage(senderId, "You've been subscribed to notifications!");
        } else {
            logger.log('info', `User ${senderId} is already subscribed.`);
            await sendTextMessage(senderId, "You're already subscribed!");
        }
    } catch (error) {
        logger.log('error', `Error in subscribeUser for ${senderId}:`, { error: error.message, stack: error.stack });
        await sendTextMessage(senderId, "Sorry, there was an error subscribing you. Please try again later.");
    }
}

async function unsubscribeUser(senderId) {
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const result = await subscribersCollection.deleteOne({ senderId: senderId });

        if (result.deletedCount > 0) {
            logger.log('info', `User ${senderId} unsubscribed.`);
            await sendTextMessage(senderId, "You've been unsubscribed from notifications.");
        } else {
            logger.log('info', `User ${senderId} was not subscribed or already unsubscribed.`);
            await sendTextMessage(senderId, "You weren't subscribed, so no action was taken.");
        }
    } catch (error) {
        logger.log('error', `Error in unsubscribeUser for ${senderId}:`, { error: error.message, stack: error.stack });
        await sendTextMessage(senderId, "Sorry, there was an error unsubscribing you. Please try again later.");
    }
}

async function broadcastToSubscribers(notificationMessage, type) {
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const allSubscribers = await subscribersCollection.find({}).toArray();

        logger.log('info', `Broadcasting ${type}: "${notificationMessage}" to ${allSubscribers.length} subscribers.`);
        if (allSubscribers.length === 0) {
            logger.log('info', 'No subscribers to broadcast to.');
            return;
        }

        // Send messages in parallel
        const sendPromises = allSubscribers.map(subscriber =>
            sendTextMessage(subscriber.senderId, notificationMessage)
        );
        
        // Wait for all messages to be processed (sent or failed)
        const results = await Promise.allSettled(sendPromises);

        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.log('error', `Failed to broadcast to ${allSubscribers[index].senderId}:`, { error: result.reason.message });
            }
        });
        logger.log('info', 'Broadcast completed.');

    } catch (error) {
        logger.log('error', 'Error in broadcastToSubscribers:', { error: error.message, stack: error.stack });
    }
}

// --- Express routes for Facebook Messenger webhook ---
app.get('/webhook', (req, res) => {
    // console.log("Received GET /webhook request"); // Keep for debugging if needed
    // console.log("Query params:", req.query);
    // console.log("Expected VERIFY_TOKEN from env:", VERIFY_TOKEN);

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            logger.log('info',"WEBHOOK_VERIFIED - Sending challenge back");
            res.status(200).send(challenge);
        } else {
            logger.log('error',"Webhook verification failed. Mode or token mismatch.");
            res.sendStatus(403);
        }
    } else {
        logger.log('warn', "Missing mode or token in GET /webhook request");
        res.sendStatus(400); // Bad Request
    }
});

// IMPORTANT: Ensure this route handler is async to properly await DB operations
app.post('/webhook', async (req, res) => {
    const body = req.body;
    // logger.log('info', 'Received POST /webhook', { body }); // Can be very verbose

    if (body.object === 'page') {
        // Use Promise.allSettled to process entries in parallel and ensure all are handled
        // before sending the response. This helps prevent the function from exiting prematurely.
        const processingPromises = body.entry.map(async (entry) => {
            if (entry.messaging && entry.messaging[0]) {
                const webhookEvent = entry.messaging[0];
                const senderId = webhookEvent.sender.id;

                // logger.log('info', `Processing event for sender ${senderId}`, { event: webhookEvent });

                if (webhookEvent.message) {
                    await handleMessage(senderId, webhookEvent.message);
                } else if (webhookEvent.postback) {
                    // await handlePostback(senderId, webhookEvent.postback); // If you add postback handling
                    logger.log('info', 'Received postback (not handled)', { senderId, postback: webhookEvent.postback });
                } else {
                    logger.log('info', 'Received unhandled webhook event type', { senderId, event: webhookEvent });
                }
            } else {
                logger.log('warn', 'Received entry with no messaging array or empty messaging array', { entry });
            }
        });

        try {
            await Promise.allSettled(processingPromises);
        } catch (error) {
            // This catch is unlikely to be hit if using allSettled,
            // as individual rejections are handled in the results.
            // But good for safety.
            logger.log('error', 'Error processing webhook entries', { error: error.message, stack: error.stack });
        }
        
        res.status(200).send('EVENT_RECEIVED');
    } else {
        logger.log('warn', "POST /webhook not from a page subscription", { object: body.object });
        res.sendStatus(404);
    }
});

// --- Message handling ---
// IMPORTANT: Ensure this function is async
async function handleMessage(senderId, message) {
    if (message.text) {
        const text = message.text.toLowerCase().trim();
        logger.log('info', `Handling message from ${senderId}: "${text}"`);

        try {
            if (text === 'subscribe') {
                await subscribeUser(senderId);
            } else if (text === 'unsubscribe') {
                await unsubscribeUser(senderId);
            } else if (text === 'help') {
                await sendTextMessage(senderId, 'Available commands:\nsubscribe - Subscribe to notifications\nunsubscribe - Stop notifications\nhelp - Show this message');
            } else {
                // Optional: Acknowledge unrecognized commands
                await sendTextMessage(senderId, "Sorry, I didn't understand that. Type 'help' for commands.");
                logger.log('info', `Unrecognized command from ${senderId}: "${text}"`);
            }
        } catch (error) {
            logger.log('error', `Error in handleMessage for ${senderId} processing "${text}":`, { error: error.message, stack: error.stack });
            try {
                // Attempt to notify user of a general error
                await sendTextMessage(senderId, "Sorry, I encountered an error. Please try again.");
            } catch (sendError) {
                logger.log('error', `Failed to send error message to ${senderId}:`, { error: sendError.message });
            }
        }
    } else if (message.attachments) {
        logger.log('info', `Received attachment from ${senderId} (not handled).`);
        await sendTextMessage(senderId, "Thanks for the attachment! I can't process those yet.");
    } else {
        logger.log('info', `Received non-text, non-attachment message from ${senderId} (not handled).`, { message });
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
        await connectToDatabase(); // Connect to DB when server starts locally
        console.log("Local server connected to MongoDB.");
    } catch (e) {
        console.error("Local server failed to connect to MongoDB on startup:", e);
    }
});
*/