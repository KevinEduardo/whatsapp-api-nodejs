const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    type: [Schema.Types.Mixed],
    });

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;