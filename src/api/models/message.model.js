const mongoose = require('mongoose')

const messageSchema = new mongoose.Schema({
    remoteJid: {
        type: String,
        required: [true, 'remoteJid is missing'],
    },
    id: {
        type: String,
        required: [true, 'id is missing'],
        unique: true,
    },
    participant: {
        type: String,
    },
})

const Message = mongoose.model('Message', messageSchema)

module.exports = Message