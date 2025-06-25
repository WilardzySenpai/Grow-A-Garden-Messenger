const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

// Initialize Express app
const app = express();
app.use(bodyParser.json());

// Facebook Messenger configuration
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Channel and topic configuration
const TOPICS = {
    WEATHER: 9,     // Weather Updates topic
    EGGS: 8,        // Egg Stocks topic
    EVENTS: 2,      // Event Stocks topic
    COSMETICS: 3,   // Cosmetics Stock topic
    SHOP: 4,        // Shop Stocks topic
    RARE: 632,      // Rare Items topic
    SUMMER_EVENT: 5939,   // Summer Event topic
};

// Rare items configuration
const RARE_ITEMS = {
    normal: [
        'Basic Sprinkler',
        'Advanced Sprinkler',
        'Grape',
        'Mushroom',
        'Pepper',
        'Cacao',
        'Legendary Egg',
        'Mythical Egg',
        'Bee Egg'
    ],
    priority: [
        'Beanstalk',
        'Ember Lily',
        'Sugar Apple',
        'Feijoa',
        'Loquat',
        'Godly Sprinkler',
        'Master Sprinkler',
        'Bug Egg'
    ]
};

// Summer seeds list
const SUMMER_SEEDS = [
    'Cauliflower',
    'Green Apple',
    'Avocado',
    'Banana',
    'Pineapple',
    'Bell Pepper',
    'Prickly pear',
    'Kiwi',
    'Feijoa',
    'Loquat'
];

// Helper functions for rare items
function isRareItem(itemName) {
    return RARE_ITEMS.normal.includes(itemName) || RARE_ITEMS.priority.includes(itemName);
}

function isPriorityRareItem(itemName) {
    return RARE_ITEMS.priority.includes(itemName);
}

// Remove file system logging for Vercel compatibility
class BotLogger {
    constructor() {
        this.statsInterval = null;
        this.stats = {
            messagesSent: 0,
            messagesQueued: 0,
            errors: 0,
            rateLimitHits: 0,
            lastResetTime: Date.now(),
            avgQueueWaitTime: 0,
            totalWaitTime: 0
        };
        this.startStatsLogging();
    }

    log(type, message, data = {}) {
        // On Vercel, just log to console
        const timestamp = new Date().toISOString();
        const logEntry = { timestamp, type, message, ...data };
        console.log(JSON.stringify(logEntry));
    }

    startStatsLogging() {
        this.statsInterval = setInterval(() => {
            this.logStats();
        }, 300000); // Log stats every 5 minutes
    }

    logStats() {
        this.log('stats', 'Performance stats', this.stats);
        this.resetStats();
    }

    resetStats() {
        this.stats = {
            messagesSent: 0,
            messagesQueued: 0,
            errors: 0,
            rateLimitHits: 0,
            lastResetTime: Date.now(),
            avgQueueWaitTime: 0,
            totalWaitTime: 0
        };
    }
}

const logger = new BotLogger();

// Facebook Messenger specific functions
function sendTextMessage(senderId, text) {
    const messageData = {
        messaging_type: 'RESPONSE',
        recipient: {
            id: senderId
        },
        message: {
            text: text
        }
    };

    callSendAPI(messageData);
}

function callSendAPI(messageData) {
    const options = {
        uri: 'https://graph.facebook.com/v17.0/me/messages',
        qs: { access_token: PAGE_ACCESS_TOKEN },
        method: 'POST',
        json: messageData
    };

    request(options, (error, response, body) => {
        if (error) {
            logger.log('error', 'Error sending message:', { error });
        }
    });
}

// WebSocket connection for game updates
const ws = new WebSocket('wss://websocket.joshlei.com/growagarden/?user_id=1377463641078497401');

ws.on('message', async (data) => {
    try {
        const message = JSON.parse(data);
        const { topic, content } = message;

        // Process different types of updates
        switch (topic) {
            case TOPICS.RARE:
                if (isRareItem(content.itemName)) {
                    const notification = `🎯 Rare Item Alert!\n${content.itemName} is now available!\nQuantity: ${content.quantity}\nPrice: ${content.price}`;
                    broadcastToSubscribers(notification, 'rare_items');
                }
                break;
            case TOPICS.SUMMER_EVENT:
                if (SUMMER_SEEDS.includes(content.itemName)) {
                    const notification = `🌞 Summer Event Update!\n${content.itemName} seeds are available!\nQuantity: ${content.quantity}\nPrice: ${content.price}`;
                    broadcastToSubscribers(notification, 'summer_event');
                }
                break;
            // Add other topics as needed
        }
    } catch (error) {
        logger.log('error', 'Error processing WebSocket message:', { error });
    }
});

// Express routes for Facebook Messenger webhook
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(entry => {
            const webhookEvent = entry.messaging[0];
            const senderId = webhookEvent.sender.id;

            if (webhookEvent.message) {
                handleMessage(senderId, webhookEvent.message);
            }
        });

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// Message handling
function handleMessage(senderId, message) {
    if (message.text) {
        const text = message.text.toLowerCase();
        
        if (text.includes('subscribe')) {
            // Handle subscription
            subscribeUser(senderId);
        } else if (text.includes('help')) {
            // Send help message
            sendTextMessage(senderId, 'Available commands:\n/subscribe - Get notifications\n/unsubscribe - Stop notifications\n/help - Show this message');
        }
    }
}

// Remove direct server listen for Vercel
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//     console.log(`Server is running on port ${PORT}`);
// });

// Export the app for Vercel
module.exports = app;