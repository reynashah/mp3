// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

// Read .env file
require('dotenv').config();

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Connect when a MongoDB Atlas URI has been configured in .env or Render.
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI).catch(function (err) {
        console.error('MongoDB connection error:', err.message);
    });
} else {
    console.warn('MONGODB_URI is not set; database endpoints will not work yet.');
}

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

// Keep malformed JSON and other parser failures in the API's required response shape.
app.use(function (err, req, res, next) {
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Invalid JSON request body', data: null });
    }
    if (err) {
        console.error(err);
        return res.status(500).json({ message: 'Internal server error', data: null });
    }
    return next();
});

// Start the server
app.listen(port);
console.log('Server running on port ' + port);
