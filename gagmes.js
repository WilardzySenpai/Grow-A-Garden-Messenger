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

// --- WebSocket Configuration & State ---
const WS_URL = 'wss://websocket.joshlei.com/growagarden/?user_id=1377463641078497401';
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000;   // 30 seconds
const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

let wsClient = null; // Renamed from 'ws' to avoid conflict with WebSocket module itself if used as 'new ws.WebSocket(...)'
let reconnectAttempt = 0;
let isWsConnected = false;
let heartbeatInterval = null;


// Item definitions for filtering messages from the external WebSocket
const RARE_ITEMS = {
    normal: ['Basic Sprinkler', 'Advanced Sprinkler', 'Grape', 'Mushroom', 'Pepper', 'Cacao', 'Legendary Egg', 'Mythical Egg', 'Bee Egg'],
    priority: ['Beanstalk', 'Ember Lily', 'Sugar Apple', 'Feijoa', 'Loquat', 'Godly Sprinkler', 'Master Sprinkler', 'Bug Egg']
};
const SUMMER_SEEDS = ['Cauliflower', 'Green Apple', 'Avocado', 'Banana', 'Pineapple', 'Bell Pepper', 'Prickly pear', 'Kiwi', 'Feijoa', 'Loquat'];

function isRareItem(itemName) {
    return RARE_ITEMS.normal.includes(itemName) || RARE_ITEMS.priority.includes(itemName);
}
function isPriorityRareItem(itemName) {
    return RARE_ITEMS.priority.includes(itemName);
}

// Local cache for current stock information (for new subscribers)
let currentStockCache = {
    latestRareItem: null,
    latestSummerSeed: null
};

class BotLogger {
    constructor() { /* Basic constructor */ }
    log(type, message, data = {}) { const timestamp = new Date().toISOString(); const logEntry = { timestamp, type, message, ...data }; console.log(JSON.stringify(logEntry)); }
}
const logger = new BotLogger();

// --- Utility Functions ---
function formatTimeRemaining(endTimeUnix) {
    if (!endTimeUnix || !Number.isFinite(endTimeUnix)) return "Time unknown";
    const now = Math.floor(Date.now() / 1000);
    const remaining = endTimeUnix - now;
    if (remaining <= 0) return "Expired";
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    let parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

// --- MongoDB Connection ---
async function connectToDatabase() {
    if (db && dbClient && dbClient.topology && dbClient.topology.isConnected()) return db;
    try {
        dbClient = new MongoClient(MONGODB_URI);
        await dbClient.connect();
        db = dbClient.db(DB_NAME);
        logger.log('INFO', "Successfully connected to MongoDB.");
        return db;
    } catch (error) {
        logger.log('ERROR', "Could not connect to MongoDB:", { error: error.message });
        throw error;
    }
}

// --- Facebook Messenger API Functions ---
async function sendTextMessage(senderId, text) {
    logger.log('INFO', `Attempting to send FB message to ${senderId}: "${text.substring(0,100)}..."`);
    const messageData = { messaging_type: 'RESPONSE', recipient: { id: senderId }, message: { text: text } };
    try {
        await callSendAPI(messageData);
    } catch (error) {
        logger.log('ERROR', `Error in sendTextMessage for FB User ${senderId}:`, { error: error.message });
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
                logger.log('SUCCESS', 'Message sent successfully to Facebook API', { recipient: messageData.recipient.id });
                resolve(body);
            } else {
                const errorDetail = { message: error ? error.message : "FB API Error", statusCode: response ? response.statusCode : "N/A", body };
                logger.log('ERROR', 'Error sending message via Facebook API:', errorDetail);
                reject(error || new Error(`FB API Error, status: ${response ? response.statusCode : 'N/A'}`));
            }
        });
    });
}

// --- WebSocket Management ---
function calculateRetryDelay(attempt) {
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
    return delay + Math.random() * 1000; // Add jitter
}

function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.ping(() => {}); // Optional callback for ping
            logger.log('DEBUG', 'WebSocket Heartbeat Ping Sent');
        }
    }, HEARTBEAT_INTERVAL_MS);
}

function connectWebSocket() {
    if (wsClient) {
        wsClient.removeAllListeners();
        wsClient.terminate();
        wsClient = null;
    }
    logger.log('INFO', `Attempting to connect to WebSocket: ${WS_URL}`);
    wsClient = new WebSocket(WS_URL);

    wsClient.on('open', () => {
        logger.log('SUCCESS', 'EXTERNAL WebSocket connection established.');
        isWsConnected = true;
        reconnectAttempt = 0;
        startHeartbeat();
    });

    wsClient.on('message', async (data) => {
        // This is where the main logic from your Telegram bot's handleMessage will go
        await handleExternalWebSocketMessage(data);
    });

    wsClient.on('pong', () => {
        logger.log('DEBUG', 'WebSocket Heartbeat Pong Received');
    });

    wsClient.on('error', (error) => {
        logger.log('ERROR', 'EXTERNAL WebSocket error:', { error: error.message });
        // isWsConnected will be set to false in 'close' event
    });

    wsClient.on('close', (code, reason) => {
        isWsConnected = false;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        const reasonStr = reason ? reason.toString() : "No reason provided";
        logger.log('WARNING', 'EXTERNAL WebSocket closed.', { code, reason: reasonStr, reconnectAttempt });

        if (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
            const delay = calculateRetryDelay(reconnectAttempt);
            logger.log('INFO', `Will attempt to reconnect WebSocket in ${delay.toFixed(0)}ms (Attempt: ${reconnectAttempt + 1})`);
            setTimeout(() => {
                reconnectAttempt++;
                connectWebSocket();
            }, delay);
        } else {
            logger.log('ERROR', 'Maximum WebSocket reconnection attempts reached. Further reconnections require manual intervention or restart.');
        }
    });
}

// --- Main Handler for External WebSocket Messages ---
async function handleExternalWebSocketMessage(data) {
    const rawDataString = data.toString();
    logger.log('DEBUG', 'RAW EXTERNAL WebSocket Data Received:', { shortData: rawDataString.substring(0, 300) + "..." });

    try {
        const stockData = JSON.parse(rawDataString); // Renamed for clarity

        // Helper to format item list for a category
        const formatItemList = (items, categoryTitle) => {
            if (!Array.isArray(items) || items.length === 0) return null;
            let message = `--- ${categoryTitle} ---\n`;
            items.forEach(item => {
                message += `🔸 ${item.display_name}\n`;
                message += `   Qty: ${item.quantity}\n`;
                message += `   Ends: ${formatTimeRemaining(item.end_date_unix)}\n\n`;
            });
            return message;
        };

        // Process and broadcast each category
        const weather = stockData.weather ? stockData.weather.find(w => w.active) : null;
        if (weather) {
            const weatherMsg = `--- WEATHER UPDATE ---\n` +
                               `🌟 Current: ${weather.weather_name}\n` +
                               `⏰ Ends in: ${formatTimeRemaining(weather.end_duration_unix)}\n`;
            await broadcastToSubscribers(weatherMsg, 'weather_update');
        }

        const eggMsg = formatItemList(stockData.egg_stock, "EGG STOCKS 🥚");
        if (eggMsg) await broadcastToSubscribers(eggMsg, 'egg_stock_update');

        const eventShopMsg = formatItemList(stockData.eventshop_stock, "EVENT SHOP 🎉");
        if (eventShopMsg) await broadcastToSubscribers(eventShopMsg, 'eventshop_update');

        const cosmeticMsg = formatItemList(stockData.cosmetic_stock, "COSMETICS SHOP 🎨");
        if (cosmeticMsg) await broadcastToSubscribers(cosmeticMsg, 'cosmetics_update');
        
        const seedMsg = formatItemList(stockData.seed_stock, "SEED SHOP 🌱");
        if (seedMsg) await broadcastToSubscribers(seedMsg, 'seed_stock_update');
        
        const gearMsg = formatItemList(stockData.gear_stock, "GEAR SHOP 🛠️");
        if (gearMsg) await broadcastToSubscribers(gearMsg, 'gear_stock_update');

        // --- Special Handling for Summer Seeds ---
        if (Array.isArray(stockData.seed_stock)) {
            const summerSeedsInStock = stockData.seed_stock.filter(item =>
                SUMMER_SEEDS.includes(item.display_name) && item.quantity > 0
            );
            if (summerSeedsInStock.length > 0) {
                const summerMsg = formatItemList(summerSeedsInStock, "SUMMER SEEDS ☀️");
                if (summerMsg) await broadcastToSubscribers(summerMsg, 'summer_seeds_update');
                // Update cache for new subscribers
                if (summerSeedsInStock[0]) currentStockCache.latestSummerSeed = { ...summerSeedsInStock[0] };
            }
        }
        
        // --- Special Handling for Rare Items ---
        let allRareItemsFound = [];
        let allPriorityRareItemsFound = [];
        const stockKeysToCheckForRare = ['seed_stock', 'gear_stock', 'egg_stock', 'cosmetic_stock', 'eventshop_stock'];
        stockKeysToCheckForRare.forEach(key => {
            if (Array.isArray(stockData[key])) {
                stockData[key].forEach(item => {
                    if (item && item.display_name && item.quantity > 0 && isRareItem(item.display_name)) {
                        const rareItemInfo = { ...item, type: key.replace('_stock', '') }; // Add type for context
                        if (isPriorityRareItem(item.display_name)) {
                            allPriorityRareItemsFound.push(rareItemInfo);
                        } else {
                            allRareItemsFound.push(rareItemInfo);
                        }
                    }
                });
            }
        });

        if (allPriorityRareItemsFound.length > 0 || allRareItemsFound.length > 0) {
            let rareBroadcastMsg = "--- RARE ITEM ALERT 🌟 ---\n";
            if (allPriorityRareItemsFound.length > 0) {
                rareBroadcastMsg += "\n🔥 SUPER RARES! 🔥\n";
                allPriorityRareItemsFound.forEach(item => {
                    rareBroadcastMsg += `🔸 ${item.display_name} (${item.type})\n   Qty: ${item.quantity}, Ends: ${formatTimeRemaining(item.end_date_unix)}\n`;
                });
                // Update cache for new subscribers (take the first priority rare)
                currentStockCache.latestRareItem = { ...allPriorityRareItemsFound[0] };
            }
            if (allRareItemsFound.length > 0) {
                rareBroadcastMsg += "\n📦 Other Rares:\n";
                allRareItemsFound.forEach(item => {
                    rareBroadcastMsg += `🔸 ${item.display_name} (${item.type})\n   Qty: ${item.quantity}, Ends: ${formatTimeRemaining(item.end_date_unix)}\n`;
                });
                // Update cache if no priority ones were found
                if (!currentStockCache.latestRareItem && allRareItemsFound[0]) {
                     currentStockCache.latestRareItem = { ...allRareItemsFound[0] };
                }
            }
            await broadcastToSubscribers(rareBroadcastMsg, 'rare_item_alert');
        }

    } catch (error) {
        logger.log('ERROR', 'Error processing EXTERNAL WebSocket message:', { error: error.message, dataPreview: rawDataString.substring(0,200), stack: error.stack });
    }
}


// --- Function to Send Current Cached Stock Summary to a New Facebook Subscriber ---
async function sendCurrentStockSummary(senderId) {
    logger.log('INFO', `Sending current cached stock summary to FB User ${senderId}`);
    let summaryParts = [];
    const rareItem = currentStockCache.latestRareItem;
    if (rareItem && rareItem.display_name) {
        summaryParts.push(`Latest Rare Item (cached):\n${rareItem.display_name} (Qty: ${rareItem.quantity}, Ends: ${formatTimeRemaining(rareItem.end_date_unix)})`);
    }
    const summerItem = currentStockCache.latestSummerSeed;
    if (summerItem && summerItem.display_name) {
        summaryParts.push(`Latest Summer Seed (cached):\n${summerItem.display_name} (Qty: ${summerItem.quantity}, Ends: ${formatTimeRemaining(summerItem.end_date_unix)})`);
    }

    if (summaryParts.length > 0) {
        const fullMessage = "Welcome! Here's the latest stock info I have from my cache (updates as new items appear):\n\n" + summaryParts.join("\n\n---\n\n");
        await sendTextMessage(senderId, fullMessage);
    } else {
        await sendTextMessage(senderId, "Welcome! My stock cache is currently empty. You'll be notified of new items as they come from the game feed!");
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
            logger.log('INFO', `Facebook User ${senderId} subscribed.`);
            await sendTextMessage(senderId, "You've been subscribed to notifications!");
            await sendCurrentStockSummary(senderId);
        } else {
            logger.log('INFO', `Facebook User ${senderId} is already subscribed.`);
            await sendTextMessage(senderId, "You're already subscribed! Here's the latest cached stock info:");
            await sendCurrentStockSummary(senderId);
        }
    } catch (error) {
        logger.log('ERROR', `Error in subscribeUser for FB User ${senderId}:`, { error: error.message });
        await sendTextMessage(senderId, "Sorry, there was an error subscribing you.");
    }
}

async function unsubscribeUser(senderId) {
    try {
        const database = await connectToDatabase();
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const result = await subscribersCollection.deleteOne({ senderId: senderId });
        if (result.deletedCount > 0) {
            logger.log('INFO', `Facebook User ${senderId} unsubscribed.`);
            await sendTextMessage(senderId, "You've been unsubscribed.");
        } else {
            logger.log('INFO', `Facebook User ${senderId} was not subscribed.`);
            await sendTextMessage(senderId, "You weren't subscribed.");
        }
    } catch (error) {
        logger.log('ERROR', `Error in unsubscribeUser for FB User ${senderId}:`, { error: error.message });
        await sendTextMessage(senderId, "Sorry, there was an error unsubscribing you.");
    }
}

async function broadcastToSubscribers(notificationMessage, typeForLogging) {
    try {
        const database = await connectToDatabase();
        if (!database) {
            logger.log('ERROR', `Cannot broadcast: No database connection for ${typeForLogging}`);
            return;
        }
        const subscribersCollection = database.collection(COLLECTION_NAME);
        const allSubscribers = await subscribersCollection.find({}).toArray();

        logger.log('INFO', `Broadcasting (type: ${typeForLogging}): "${notificationMessage.substring(0,100)}..." to ${allSubscribers.length} subscribed FB users.`);
        if (allSubscribers.length === 0) {
            logger.log('INFO', 'No Facebook subscribers to broadcast to.');
            return;
        }

        const sendPromises = allSubscribers.map(subscriber =>
            sendTextMessage(subscriber.senderId, notificationMessage)
        );
        
        const results = await Promise.allSettled(sendPromises);
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.log('ERROR', `Failed to broadcast to FB User ${allSubscribers[index].senderId}:`, { error: result.reason ? result.reason.message : "Unknown reason" });
            }
        });
        logger.log('INFO', `Broadcast type '${typeForLogging}' to Facebook users completed.`);

    } catch (error) {
        logger.log('ERROR', `Error in broadcastToSubscribers (to FB users for ${typeForLogging}):`, { error: error.message });
    }
}

// --- Express Routes for Facebook Messenger Webhook ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            logger.log('INFO',"Facebook WEBHOOK_VERIFIED - Sending challenge back");
            res.status(200).send(challenge);
        } else {
            logger.log('ERROR',"Facebook Webhook verification failed.");
            res.sendStatus(403);
        }
    } else {
        logger.log('WARNING', "Missing params in Facebook GET /webhook request");
        res.sendStatus(400);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        // Acknowledge receipt to Facebook quickly.
        // Actual processing happens after the response is sent.
        res.status(200).send('EVENT_RECEIVED'); 
        
        // Process asynchronously
        for (const entry of body.entry) {
            if (entry.messaging && entry.messaging[0]) {
                const webhookEvent = entry.messaging[0];
                const senderId = webhookEvent.sender.id;
                try {
                    if (webhookEvent.message) {
                        await handleFacebookUserMessage(senderId, webhookEvent.message);
                    } else if (webhookEvent.postback) {
                        logger.log('INFO', 'Received Facebook postback (not handled)', { senderId });
                    }
                } catch (err) {
                     logger.log('ERROR', 'Error processing an individual webhook event', { senderId, error: err.message });
                }
            } else {
                logger.log('WARNING', 'Received Facebook entry with no/empty messaging array', { entryId: entry.id });
            }
        }
    } else {
        logger.log('WARNING', "POST /webhook not from a Facebook page subscription");
        res.sendStatus(404);
    }
});

// --- Message Handling (for messages from Facebook Users) ---
async function handleFacebookUserMessage(senderId, message) { // Renamed for clarity
    if (message.text) {
        const text = message.text.toLowerCase().trim();
        logger.log('INFO', `Handling Facebook message from ${senderId}: "${text}"`);
        try {
            if (text === 'subscribe') {
                await subscribeUser(senderId);
            } else if (text === 'unsubscribe') {
                await unsubscribeUser(senderId);
            } else if (text === 'help') {
                await sendTextMessage(senderId, 'Available commands:\nsubscribe - Get notifications\nunsubscribe - Stop notifications\nhelp - Show this message');
            } else {
                await sendTextMessage(senderId, "Sorry, I didn't understand that. Type 'help' for commands.");
            }
        } catch (error) {
            logger.log('ERROR', `Error in handleFacebookUserMessage for ${senderId} ("${text}"):`, { error: error.message });
            await sendTextMessage(senderId, "Sorry, an error occurred.");
        }
    } else if (message.attachments) {
        logger.log('INFO', `Received attachment from FB User ${senderId} (not handled).`);
        await sendTextMessage(senderId, "I can't process attachments yet.");
    }
}

// --- Initialize External WebSocket Connection on Startup ---
// (Vercel will run this when the function cold starts)
connectWebSocket();


// Export the app for Vercel
module.exports = app;

// Optional: If running locally for testing
/*
const PORT_LOCAL = process.env.PORT || 3000;
app.listen(PORT_LOCAL, async () => {
    logger.log('INFO', `Local server running on port ${PORT_LOCAL}`);
    try {
        await connectToDatabase();
    } catch (e) {
        // Error already logged by connectToDatabase
    }
    // External WebSocket connection is initiated globally above
});
*/