import dotenv from "dotenv";
const validUrl = require('valid-url');
import { ToadScheduler, SimpleIntervalJob, AsyncTask } from 'toad-scheduler';
import router from "./routes/routes";
import {IllegalArgumentError} from "./exceptions/IllegalArgumentError";
import {EventPuller} from "./subscriber/puller";
import notifier from "./subscriber/notifier";
import {DomeContract} from "./utils/funcs";
import express from "express";
import morgan from "morgan";
import {validator as tolarValidator} from "@tolar/web3-plugin-tolar";
import { validator } from "web3";

dotenv.config();

if(!validUrl.isWebUri(process.env.RPC_ADDRESS)) {
    throw new IllegalArgumentError("RPC_ADDRESS is missing or invalid format");
}

if(process.env.DOME_EVENTS_CONTRACT_ADDRESS === undefined ||
    tolarValidator.isTolAddressValid(process.env.DOME_EVENTS_CONTRACT_ADDRESS) !== "") {
    throw new IllegalArgumentError("DOME_EVENTS_CONTRACT_ADDRESS is missing or invalid format");
}

if(process.env.DOME_EVENTS_CONTRACT_ABI === undefined ||
    process.env.DOME_EVENTS_CONTRACT_ABI === "") {
    throw new IllegalArgumentError("DOME_EVENTS_CONTRACT_ABI is missing");
}

if(process.env.DOME_PRODUCTION_BLOCK_NUMBER === undefined ||
    !validator.isUInt(process.env.DOME_PRODUCTION_BLOCK_NUMBER)) {
    throw new IllegalArgumentError("DOME_PRODUCTION_BLOCK_NUMBER is missing or in invalid format");
}

if (process.env.ISS === undefined || !validator.isHexString(process.env.ISS)) {
    throw new IllegalArgumentError("ISS is ");
}

if (process.env.PRIVATE_KEY === undefined || !validator.isHexString(process.env.PRIVATE_KEY)) {
    throw new IllegalArgumentError("PRIVATE_KEY is missing or in invalid format");
}

const app = express()
const port = 8080

// Disable expressjs version in headers.
app.disable("x-powered-by");

// Logging
app.use(morgan("dev"))

/** Parse the request */
app.use(express.urlencoded({ extended: false }));

/** Takes care of JSON data */
app.use(express.json());

router.use((req: any, res: any, next: any) => {

    // Define an array of allowed origins (replace with your actual origins)
    const allowedOrigins = ['*'];

    // Check if the request origin is in the allowed origins
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        console.log("*****"+req.header);
    }

    // Set the allowed headers and methods
    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    );
    res.header('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, POST');

    // Handle preflight requests (OPTIONS)
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Continue with the request
    next();
});

/** Routes */
app.use("/", router)

/** Error handling */
app.use((req: any, res: any, next: any) => {
    const error = new Error("Not Found");
    return res.status(404).json({ message: error.message });
});

app.listen(port, () => {
    console.log(`DLT Interface API listening at http://localhost:${port}`)
});

const eventPuller = new EventPuller(
    process.env.RPC_ADDRESS!,
    process.env.DOME_EVENTS_CONTRACT_ADDRESS!,
    DomeContract.instance.eventDOMEv1Abi,
    1
);

const notificationTask = new AsyncTask(
    'Notification Task',
    async () => {
        if(notifier.subscriber_count() === 0) {
            return;
        }
        const events = await eventPuller.pull();
        if(events === undefined || events.length === 0) {
            return;
        }

        await notifier.notify(events);
    },
    (err: Error) => { console.log(err); }
);

const scheduler = new ToadScheduler();
scheduler.addSimpleIntervalJob(new SimpleIntervalJob({ seconds: 5, }, notificationTask));

module.exports = {app, scheduler}

