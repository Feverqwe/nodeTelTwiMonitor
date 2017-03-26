/**
 * Created by Anton on 19.03.2017.
 */
"use strict";
var debug = require('debug')('app:service');

var Service = function () {

};

/**
 * @typedef {{}} ChannelInfo
 * @property {String} id
 * @property {String} title
 */

/**
 * @private
 * @param {String[]} channelIds
 * @return {Promise.<ChannelInfo[]>}
 */
Service.prototype.getChannelsInfo = function (channelIds) {
    var _this = this;
    var db = this.gOptions.db;
    return new Promise(function (resolve, reject) {
        if (!channelIds.length) {
            return resolve([]);
        }

        db.connection.query('\
            SELECT * FROM ' + _this.dbTable + ' WHERE id IN ?; \
        ', [[channelIds]], function (err, results) {
            if (err) {
                reject(err);
            } else {
                resolve(results);
            }
        });
    }).catch(function (err) {
        debug('getChannelsInfo', err);
        return [];
    });
};

/**
 * @param {ChannelInfo} info
 * @return {String}
 */
Service.prototype.getChannelTitleFromInfo = function (info) {
    return info.title || info.id;
};

/**
 * @param {String} channelId
 * @return {Promise.<String>}
 */
Service.prototype.getChannelTitle = function (channelId) {
    var _this = this;
    return this.getChannelsInfo([channelId]).then(function (infoList) {
        var info = infoList[0] || {};
        return _this.getChannelTitleFromInfo(info) || channelId;
    });
};

/**
 * @param {Object} info
 * @return {Promise}
 */
Service.prototype.setChannelInfo = function(info) {
    var _this = this;
    var db = this.gOptions.db;
    return new Promise(function (resolve, reject) {
        db.connection.query('\
            INSERT INTO ' + _this.dbTable + ' SET ? ON DUPLICATE KEY UPDATE ? \
        ', [info, info], function (err, results) {
            if (err) {
                debug('setChannelInfo', err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

/**
 * @param {String} channelId
 * @param {String} channelTitle
 * @return {Promise}
 */
Service.prototype.setChannelTitle = function (channelId, channelTitle) {
    var _this = this;
    var db = this.gOptions.db;
    return new Promise(function (resolve, reject) {
        db.connection.query('\
            UPDATE ' + _this.dbTable + ' SET title = ? WHERE id = ? \
        ', [channelTitle, channelId], function (err, results) {
            if (err) {
                debug('setChannelTitle', err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

Service.prototype._insertItem = function (stream, messages) {
    var _this = this;
    var db = _this.gOptions.db;
    return db.newConnection().then(function (connection) {
        return new Promise(function (resolve, reject) {
            connection.beginTransaction(function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        }).then(function () {
            return _this.gOptions.msgStack.insertStream(connection, stream);
        }).then(function () {
            return _this.gOptions.msgStack.addChatIdStreamId(connection, messages, stream.id);
        }).then(function () {
            return new Promise(function (resolve, reject) {
                connection.commit(function (err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        }).catch(function (err) {
            return new Promise(function (resolve) {
                connection.rollback(resolve);
            }).then(function () {
                throw err;
            });
        }).then(function (result) {
            connection.end();
            return result;
        }, function (err) {
            connection.end();
            throw err;
        });
    }).catch(function (err) {
        debug('_insertItem', err);
    });
};

Service.prototype.insertTimeoutItems = function (serviceName, channelIds) {
    var _this = this;

    var insertTimeoutItem = function (stream) {
        var _this = this;
        if (!stream.isOffline) {
            stream.isOffline = 1;
            return _this.gOptions.msgStack.getLiveMessages(stream.id, stream.service).then(function (messages) {
                return _this._insertItem(stream, messages);
            }).catch(function (err) {
                debug('insertTimeoutItem', err);
            });
        }
    };

    return _this.gOptions.msgStack.getStreamsByChannelIds(channelIds, serviceName).then(function (streams) {
        return Promise.all(streams.map(function (stream) {
            return insertTimeoutItem(stream);
        }));
    });
};

module.exports = Service;