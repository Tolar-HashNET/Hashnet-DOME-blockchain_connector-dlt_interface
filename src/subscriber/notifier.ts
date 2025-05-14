import axios, {AxiosInstance} from "axios";
import {DomeEvent, SubscriberFilter} from "../utils/types";

interface Subscriber {
    axiosInstance: AxiosInstance;
    filter: SubscriberFilter;
}

async function notifyOne(axiosInstance: AxiosInstance, event: DomeEvent) {
    try {
        await axiosInstance.post("", event);
    } catch (e) {
        if (e instanceof Error) {
            console.error(`Failed to post notification to ${axiosInstance.getUri()} with error: ${e.message}`);
        } else {
            console.error(`Failed to post notification to ${axiosInstance.getUri()} with unknown error`);
        }
    }
}

class Notifier {
    private _subscribers = new Map<string, Subscriber>();

    public subscriber_count() : number {
        return this._subscribers.size;
    }

    public add(notificationEndpoint: string, filter: SubscriberFilter) {
        this._subscribers.set(
            notificationEndpoint,
            {
                axiosInstance: axios.create({
                    baseURL: notificationEndpoint,
                    timeout: 2000,
                    headers: {"Content-Type": "application/json"}
                }), filter: filter
            }
        );
    }

    public async notify(events: DomeEvent[]) {
        if (events.length == 0) {
            return;
        }

        const notifyPromises: Promise<void>[] = [];
        for (const event of events) {
            for (const {axiosInstance, filter} of this._subscribers.values()) {
                if (!filter.eventTypes.includes(event.eventType)) {
                    continue;
                }

                if (event.publisherAddress !== filter.ownIss) {
                    continue;
                }

                notifyPromises.push(notifyOne(axiosInstance, event));
            }
        }

        await Promise.all(notifyPromises);
    }
}

const notifier = new Notifier();

export = notifier;
