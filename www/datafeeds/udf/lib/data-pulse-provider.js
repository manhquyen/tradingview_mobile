import { getErrorMessage, logMessage, } from './helpers';
var DataPulseProvider = /** @class */ (function () {
    function DataPulseProvider(historyProvider, datafeedSocket, updateFrequency) {
        this._subscribers = {};
        this._requestsPending = 0;
        this._socketHost = '';
        this._historyProvider = historyProvider;
        this._updateFrequency = updateFrequency;
        this.intervalGet = setInterval(this._updateData.bind(this), this._updateFrequency);
        this._socketHost = datafeedSocket;
        this.socketInstance = null;
    }
    DataPulseProvider.prototype.subscribeBars = function (symbolInfo, resolution, newDataCallback, listenerGuid) {
        var _this = this;
        var channelString = createChannelString(symbolInfo, resolution);
        if (this.socketInstance) {
            this.socketInstance.close();
        }
        this.socketInstance = new WebSK();
        this.socketInstance.open(this._socketHost + "/" + channelString);
        this.socketInstance.onmessage = function (event, flags, number) {
            var data = JSON.parse(event.data);
            newDataCallback({
                time: data.openTime,
                close: parseFloat(data.close),
                open: parseFloat(data.open),
                high: parseFloat(data.max),
                low: parseFloat(data.min),
                volume: parseFloat(data.volume)
            });
        };
        this.socketInstance.onopen = function () {
            clearInterval(_this.intervalGet);
        };
        this.socketInstance.onclose = function () {
            clearInterval(_this.intervalGet);
            _this.intervalGet = setInterval(_this._updateData.bind(_this), _this._updateFrequency);
        };
        this.socketInstance.onerror = function () {
            clearInterval(_this.intervalGet);
            _this.intervalGet = setInterval(_this._updateData.bind(_this), _this._updateFrequency);
        };
        if (this._subscribers.hasOwnProperty(listenerGuid)) {
            logMessage("DataPulseProvider: already has subscriber with id=" + listenerGuid);
            return;
        }
        this._subscribers[listenerGuid] = {
            lastBarTime: null,
            listener: newDataCallback,
            resolution: resolution,
            symbolInfo: symbolInfo,
        };
        logMessage("DataPulseProvider: subscribed for #" + listenerGuid + " - {" + symbolInfo.name + ", " + resolution + "}");
    };
    DataPulseProvider.prototype.unsubscribeBars = function (listenerGuid) {
        if (socketInstance) {
            socketInstance.close();
        }
        delete this._subscribers[listenerGuid];
        logMessage("DataPulseProvider: unsubscribed for #" + listenerGuid);
    };
    DataPulseProvider.prototype._updateData = function () {
        var _this = this;
        if (this._requestsPending > 0) {
            return;
        }
        this._requestsPending = 0;
        var _loop_1 = function (listenerGuid) {
            this_1._requestsPending += 1;
            this_1._updateDataForSubscriber(listenerGuid)
                .then(function () {
                _this._requestsPending -= 1;
                logMessage("DataPulseProvider: data for #" + listenerGuid + " updated successfully, pending=" + _this._requestsPending);
            })
                .catch(function (reason) {
                _this._requestsPending -= 1;
                logMessage("DataPulseProvider: data for #" + listenerGuid + " updated with error=" + getErrorMessage(reason) + ", pending=" + _this._requestsPending);
            });
        };
        var this_1 = this;
        for (var listenerGuid in this._subscribers) {
            _loop_1(listenerGuid);
        }
    };
    DataPulseProvider.prototype._updateDataForSubscriber = function (listenerGuid) {
        var _this = this;
        var subscriptionRecord = this._subscribers[listenerGuid];
        var rangeEndTime = parseInt((Date.now() / 1000).toString());
        // BEWARE: please note we really need 2 bars, not the only last one
        // see the explanation below. `10` is the `large enough` value to work around holidays
        var rangeStartTime = rangeEndTime - periodLengthSeconds(subscriptionRecord.resolution, 10);
        return this._historyProvider.getBars(subscriptionRecord.symbolInfo, subscriptionRecord.resolution, rangeStartTime, rangeEndTime)
            .then(function (result) {
            _this._onSubscriberDataReceived(listenerGuid, result);
        });
    };
    DataPulseProvider.prototype._onSubscriberDataReceived = function (listenerGuid, result) {
        // means the subscription was cancelled while waiting for data
        if (!this._subscribers.hasOwnProperty(listenerGuid)) {
            logMessage("DataPulseProvider: Data comes for already unsubscribed subscription #" + listenerGuid);
            return;
        }
        var bars = result.bars;
        if (bars.length === 0) {
            return;
        }
        var lastBar = bars[bars.length - 1];
        var subscriptionRecord = this._subscribers[listenerGuid];
        if (subscriptionRecord.lastBarTime !== null && lastBar.time < subscriptionRecord.lastBarTime) {
            return;
        }
        var isNewBar = subscriptionRecord.lastBarTime !== null && lastBar.time > subscriptionRecord.lastBarTime;
        // Pulse updating may miss some trades data (ie, if pulse period = 10 secods and new bar is started 5 seconds later after the last update, the
        // old bar's last 5 seconds trades will be lost). Thus, at fist we should broadcast old bar updates when it's ready.
        if (isNewBar) {
            if (bars.length < 2) {
                throw new Error('Not enough bars in history for proper pulse update. Need at least 2.');
            }
            var previousBar = bars[bars.length - 2];
            subscriptionRecord.listener(previousBar);
        }
        subscriptionRecord.lastBarTime = lastBar.time;
        subscriptionRecord.listener(lastBar);
    };
    return DataPulseProvider;
}());
export { DataPulseProvider };
function periodLengthSeconds(resolution, requiredPeriodsCount) {
    var daysCount = 0;
    if (resolution === 'D' || resolution === '1D') {
        daysCount = requiredPeriodsCount;
    }
    else if (resolution === 'M' || resolution === '1M') {
        daysCount = 31 * requiredPeriodsCount;
    }
    else if (resolution === 'W' || resolution === '1W') {
        daysCount = 7 * requiredPeriodsCount;
    }
    else {
        daysCount = requiredPeriodsCount * parseInt(resolution) / (24 * 60);
    }
    return daysCount * 24 * 60 * 60;
}
function createChannelString(symbolInfo, resolution) {
    if (['1', '3', '5', '15', '30'].indexOf(resolution) !== -1) {
        resolution = resolution + 'm';
    }
    else if (['60', '120', '240', '360', '480', '720'].indexOf(resolution) !== -1) {
        resolution = Number(resolution) / 60 + 'h';
    }
    else if (['1D', '3D'].indexOf(resolution) !== -1) {
        resolution = resolution.toLowerCase();
    }
    else if (['1M'].indexOf(resolution) !== -1) {
    }
    else {
        resolution = '15m';
    }
    // BTC_1m
    return symbolInfo.name.replace('/VNDC', '').toUpperCase() + "_" + resolution;
}
var WebSK = /** @class */ (function () {
    function WebSK() {
        this.number = 0;
        this.autoReconnectInterval = 5 * 1000; // ms
    }
    WebSK.prototype.open = function (url) {
        var _this = this;
        this.url = url;
        this.instance = new WebSocket(this.url);
        this.instance.onopen = function () {
            _this.onopen();
        };
        this.instance.onmessage = function (data, flags) {
            _this.number++;
            _this.onmessage(data, flags, _this.number);
        };
        this.instance.onclose = function (e) {
            switch (e.code) {
                case 1000: // CLOSE_NORMAL
                    console.log("WebSocket: closed");
                    break;
                case 1005: // CLOSE_NORMAL_FROM_SERVER
                    console.log("WebSocket: closed");
                    break;
                default: // Abnormal closure
                    _this.reconnect(e);
                    break;
            }
            _this.onclose(e);
        };
        this.instance.onerror = function (e) {
            switch (e.code) {
                case 'ECONNREFUSED':
                    _this.reconnect(e);
                    break;
                default:
                    _this.onerror(e);
                    break;
            }
        };
    };
    WebSK.prototype.close = function () {
        this.instance.close();
    };
    WebSK.prototype.onopen = function (e) {
        console.log("WebSocketClient: open", arguments);
    };
    WebSK.prototype.onmessage = function (data, flags, number) {
        console.log("WebSocketClient: message", arguments);
    };
    WebSK.prototype.onerror = function (e) {
        console.log("WebSocketClient: error", arguments);
    };
    WebSK.prototype.onclose = function (e) {
        console.log("WebSocketClient: closed", arguments);
    };
    WebSK.prototype.reconnect = function (e) {
        console.log("WebSocketClient: retry in " + this.autoReconnectInterval + "ms", e);
        var that = this;
        setTimeout(function () {
            console.log("WebSocketClient: reconnecting...");
            that.open(that.url);
        }, this.autoReconnectInterval);
    };
    return WebSK;
}());
