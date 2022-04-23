// @ts-nocheck
import {
	LibrarySymbolInfo,
	SubscribeBarsCallback,
} from '../../../charting_library/datafeed-api';

import {
	GetBarsResult,
	HistoryProvider,
} from './history-provider';

import {
	getErrorMessage,
	logMessage,
} from './helpers';

interface DataSubscriber {
	symbolInfo: LibrarySymbolInfo;
	resolution: string;
	lastBarTime: number | null;
	listener: SubscribeBarsCallback;
}

interface DataSubscribers {
	[guid: string]: DataSubscriber;
}

export class DataPulseProvider {
	private readonly _subscribers: DataSubscribers = {};
	private _requestsPending: number = 0;
	private readonly _historyProvider: HistoryProvider;
	private intervalGet: any
	private readonly _socketHost: string = ''
	private socketInstance: any
	private _updateFrequency: any

	public constructor(historyProvider: HistoryProvider, datafeedSocket: string, updateFrequency: number) {
		this._historyProvider = historyProvider
		this._updateFrequency = updateFrequency
		this.intervalGet = setInterval(this._updateData.bind(this), this._updateFrequency)
		this._socketHost = datafeedSocket
		this.socketInstance = null
	}

	public subscribeBars(symbolInfo: LibrarySymbolInfo, resolution: string, newDataCallback: SubscribeBarsCallback, listenerGuid: string): void {
		const channelString = createChannelString(symbolInfo, resolution)
		if (this.socketInstance) {
			this.socketInstance.close()
		}
		this.socketInstance = new WebSK()
		this.socketInstance.open(`${this._socketHost}/${channelString}`)
		this.socketInstance.onmessage = (event, flags, number) => {
			let data = JSON.parse(event.data)
			newDataCallback({
				time: data.openTime,
				close: parseFloat(data.close),
				open: parseFloat(data.open),
				high: parseFloat(data.max),
				low: parseFloat(data.min),
				volume: parseFloat(data.volume)
			})
		}

		this.socketInstance.onopen = () => {
			clearInterval(this.intervalGet)
		}

		this.socketInstance.onclose = () => {
			clearInterval(this.intervalGet)
			this.intervalGet = setInterval(this._updateData.bind(this), this._updateFrequency)
		}

		this.socketInstance.onerror = () => {
			clearInterval(this.intervalGet)
			this.intervalGet = setInterval(this._updateData.bind(this), this._updateFrequency)
		}

		if (this._subscribers.hasOwnProperty(listenerGuid)) {
			logMessage(`DataPulseProvider: already has subscriber with id=${listenerGuid}`);
			return;
		}

		this._subscribers[listenerGuid] = {
			lastBarTime: null,
			listener: newDataCallback,
			resolution: resolution,
			symbolInfo: symbolInfo,
		};

		logMessage(`DataPulseProvider: subscribed for #${listenerGuid} - {${symbolInfo.name}, ${resolution}}`);
	}

	public unsubscribeBars(listenerGuid: string): void {
		if (socketInstance) {
			socketInstance.close()
		}
		delete this._subscribers[listenerGuid];
		logMessage(`DataPulseProvider: unsubscribed for #${listenerGuid}`);
	}

	private _updateData(): void {
		if (this._requestsPending > 0) {
			return;
		}

		this._requestsPending = 0;
		for (const listenerGuid in this._subscribers) { // tslint:disable-line:forin
			this._requestsPending += 1;
			this._updateDataForSubscriber(listenerGuid)
				.then(() => {
					this._requestsPending -= 1;
					logMessage(`DataPulseProvider: data for #${listenerGuid} updated successfully, pending=${this._requestsPending}`);
				})
				.catch((reason?: string | Error) => {
					this._requestsPending -= 1;
					logMessage(`DataPulseProvider: data for #${listenerGuid} updated with error=${getErrorMessage(reason)}, pending=${this._requestsPending}`);
				});
		}
	}

	private _updateDataForSubscriber(listenerGuid: string): Promise<void> {
		const subscriptionRecord = this._subscribers[listenerGuid];

		const rangeEndTime = parseInt((Date.now() / 1000).toString());

		// BEWARE: please note we really need 2 bars, not the only last one
		// see the explanation below. `10` is the `large enough` value to work around holidays
		const rangeStartTime = rangeEndTime - periodLengthSeconds(subscriptionRecord.resolution, 10);

		return this._historyProvider.getBars(subscriptionRecord.symbolInfo, subscriptionRecord.resolution, rangeStartTime, rangeEndTime)
			.then((result: GetBarsResult) => {
				this._onSubscriberDataReceived(listenerGuid, result);
			});
	}

	private _onSubscriberDataReceived(listenerGuid: string, result: GetBarsResult): void {
		// means the subscription was cancelled while waiting for data
		if (!this._subscribers.hasOwnProperty(listenerGuid)) {
			logMessage(`DataPulseProvider: Data comes for already unsubscribed subscription #${listenerGuid}`);
			return;
		}

		const bars = result.bars;
		if (bars.length === 0) {
			return;
		}

		const lastBar = bars[bars.length - 1];
		const subscriptionRecord = this._subscribers[listenerGuid];

		if (subscriptionRecord.lastBarTime !== null && lastBar.time < subscriptionRecord.lastBarTime) {
			return;
		}

		const isNewBar = subscriptionRecord.lastBarTime !== null && lastBar.time > subscriptionRecord.lastBarTime;

		// Pulse updating may miss some trades data (ie, if pulse period = 10 secods and new bar is started 5 seconds later after the last update, the
		// old bar's last 5 seconds trades will be lost). Thus, at fist we should broadcast old bar updates when it's ready.
		if (isNewBar) {
			if (bars.length < 2) {
				throw new Error('Not enough bars in history for proper pulse update. Need at least 2.');
			}

			const previousBar = bars[bars.length - 2];
			subscriptionRecord.listener(previousBar);
		}

		subscriptionRecord.lastBarTime = lastBar.time;
		subscriptionRecord.listener(lastBar);
	}
}

function periodLengthSeconds(resolution: string, requiredPeriodsCount: number): number {
	let daysCount = 0;

	if (resolution === 'D' || resolution === '1D') {
		daysCount = requiredPeriodsCount;
	} else if (resolution === 'M' || resolution === '1M') {
		daysCount = 31 * requiredPeriodsCount;
	} else if (resolution === 'W' || resolution === '1W') {
		daysCount = 7 * requiredPeriodsCount;
	} else {
		daysCount = requiredPeriodsCount * parseInt(resolution) / (24 * 60);
	}

	return daysCount * 24 * 60 * 60;
}

function createChannelString(symbolInfo: any, resolution: any): string {
	if (['1', '3', '5', '15', '30'].indexOf(resolution) !== -1) {
		resolution = resolution + 'm'
	} else if (['60', '120', '240', '360', '480', '720'].indexOf(resolution) !== -1) {
		resolution = Number(resolution)/60 + 'h'
	} else if (['1D', '3D'].indexOf(resolution) !== -1) {
		resolution = resolution.toLowerCase()
	} else if(['1M'].indexOf(resolution) !== -1) {

	} else {
		resolution = '15m';
	}
	// BTC_1m
	return `${symbolInfo.name.replace('/VNDC', '').toUpperCase()}_${resolution}`
}

class WebSK {
	constructor() {
		this.number = 0
		this.autoReconnectInterval = 5*1000;  // ms
	}
	open (url) {
		this.url = url;
		this.instance = new WebSocket(this.url);
		this.instance.onopen = () => {
			this.onopen()
		}
		this.instance.onmessage = (data, flags) => {
			this.number ++;
			this.onmessage(data, flags, this.number)
		}
		this.instance.onclose = (e) => {
			switch (e.code){
				case 1000:  // CLOSE_NORMAL
					console.log("WebSocket: closed");
					break;
				case 1005:  // CLOSE_NORMAL_FROM_SERVER
					console.log("WebSocket: closed");
					break;
				default:  // Abnormal closure
					this.reconnect(e);
					break;
			}
			this.onclose(e)
		}
		this.instance.onerror = (e) => {
			switch (e.code){
				case 'ECONNREFUSED':
					this.reconnect(e);
					break;
				default:
					this.onerror(e);
					break;
			}
		}
	}
	close () {
		this.instance.close()
	}
	onopen (e) {
		console.log("WebSocketClient: open", arguments)
	}
	onmessage (data, flags, number) {
		console.log("WebSocketClient: message",arguments)
	}
	onerror (e) {
		console.log("WebSocketClient: error",arguments)
	}
	onclose (e) {
		console.log("WebSocketClient: closed",arguments)
	}
	reconnect (e){
		console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`,e);
		var that = this;
		setTimeout(() => {
			console.log("WebSocketClient: reconnecting...");
			that.open(that.url);
		}, this.autoReconnectInterval);
	}
}