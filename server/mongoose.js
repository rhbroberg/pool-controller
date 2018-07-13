var mongoose = require('mongoose');

mongoose.Promise = global.Promise;
mongoose.connect(process.env.MONGODB_URI, { useMongoCliewnt: true }, function(error) {
    if (error) {
        console.log(`cannot connect to mongodb: ${process.env.MONGODB_URI} : ${error}`);
        throw new Error('darn, thats the end');
    }
});

module.exports = {
    mongoose
};
