var mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI).catch((error) => {
    console.log(`cannot connect to mongodb: ${process.env.MONGODB_URI} : ${error}`);
    throw new Error('darn, thats the end');
});

module.exports = {
    mongoose
};
