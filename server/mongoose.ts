import mongoose from 'mongoose';

mongoose.connect(process.env.MONGODB_URI as string).catch((error: unknown) => {
    console.log(`cannot connect to mongodb: ${process.env.MONGODB_URI} : ${error}`);
    throw new Error('darn, thats the end');
});

export { mongoose };
