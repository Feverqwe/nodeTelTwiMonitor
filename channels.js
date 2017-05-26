/**
 * Created by Anton on 30.04.2017.
 */
"use strict";
const debug = require('debug')('app:channels');

var Channels = function (options) {
    this.gOptions = options;
    this.onReady = this.init();
};

Channels.prototype.init = function () {
    var _this = this;
    var db = this.gOptions.db;
    return new Promise(function (resolve, reject) {
        db.connection.query('\
            CREATE TABLE IF NOT EXISTS channels ( \
                `id` VARCHAR(191) CHARACTER SET utf8mb4 NOT NULL, \
                `service` VARCHAR(191) CHARACTER SET utf8mb4 NOT NULL, \
                `title` TEXT CHARACTER SET utf8mb4 NULL, \
                `url` TEXT CHARACTER SET utf8mb4 NOT NULL, \
            INDEX `id_idx` (`id` ASC),  \
            INDEX `service_idx` (`service` ASC),  \
            UNIQUE INDEX `id_UNIQUE` (`id` ASC),\
            UNIQUE INDEX `idService_UNIQUE` (`id` ASC, `service` ASC)); \
        ', function (err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    }).then(function () {
        return _this.migrate();
    });
};

Channels.prototype.migrate = function () {
    var _this = this;
    const base = require('./base');
    var db = _this.gOptions.db;

    var getServiceChannels = function (service) {
        return new Promise(function (resolve, reject) {
            db.connection.query('\
            SELECT * FROM channels WHERE service = ?; \
        ', service, function (err, results) {
                if (err) {
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });
    };

    var insertPool = new base.Pool(10);

    var service = 'beam';
    var newService = 'mixer';
    return getServiceChannels(service).then(function (channels) {
        return insertPool.do(function () {
            var channel = channels.shift();
            if (!channel) return;


            var id = channel.id;
            var newId = _this.wrapId(_this.unWrapId(id), newService);

            return _this.updateChannel(id, {
                id: newId,
                service: newService,
                url: 'https://mixer.com/' + id
            });
        });
    });
};

/**
 * @param {string} id
 * @param {string} service
 */
Channels.prototype.wrapId = function (id, service) {
    return [service.substr(0, 2), JSON.stringify(id)].join(':');
};

Channels.prototype.unWrapId = function (id) {
    var _id = id.substr(3);
    return JSON.parse(_id);
};

/**
 * @typedef {{}} dbChannel
 * @property {string} id
 * @property {string} service
 * @property {string} title
 * @property {string} url
 */

/**
 * @private
 * @param {string[]} ids
 * @return {Promise.<dbChannel[]>}
 */
Channels.prototype.getChannels = function (ids) {
    var _this = this;
    var db = this.gOptions.db;
    return new Promise(function (resolve, reject) {
        if (!ids.length) {
            return resolve([]);
        }

        db.connection.query('\
            SELECT * FROM channels WHERE id IN ?; \
        ', [[ids]], function (err, results) {
            if (err) {
                reject(err);
            } else {
                resolve(results);
            }
        });
    }).catch(function (err) {
        debug('getChannels', err);
        return [];
    });
};

/**
 * @param {*} id
 * @param {string} service
 * @param {string} title
 * @param {string} url
 * @return {Promise.<dbChannel>}
 */
Channels.prototype.insertChannel = function(id, service, title, url) {
    var _this = this;
    var db = this.gOptions.db;
    var info = {
        id: _this.wrapId(id, service),
        service: service,
        title: title,
        url: url
    };
    return new Promise(function (resolve, reject) {
        db.connection.query('\
            INSERT INTO channels SET ? ON DUPLICATE KEY UPDATE ? \
        ', [info, info], function (err, results) {
            if (err) {
                debug('insertChannel', err);
                reject(err);
            } else {
                resolve(info);
            }
        });
    });
};

/**
 * @param {string} id
 * @param {dbChannel} channel
 */
Channels.prototype.updateChannel = function (id, channel) {
    var _this = this;
    var db = this.gOptions.db;
    return new Promise(function (resolve, reject) {
        db.connection.query('\
            UPDATE channels SET ? WHERE id = ? \
        ', [channel, id], function (err, results) {
            if (err) {
                debug('updateChannel', err);
                reject(err);
            } else {
                resolve();
            }
        });
    }).catch(function (err) {
        debug('updateChannel', err);
    });
};

module.exports = Channels;