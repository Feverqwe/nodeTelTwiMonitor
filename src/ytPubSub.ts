import Main from './main';
import {everyMinutes} from './tools/everyTime';
import parallel from './tools/parallel';
import serviceId from './tools/serviceId';
import ErrorWithCode from './tools/errorWithCode';
import arrayDifference from './tools/arrayDifference';
import {YtPubSubChannel, YtPubSubChannelModel, YtPubSubFeed} from './db';
import LogFile from './logFile';
import arrayByPart from './tools/arrayByPart';
import ExpressPubSub from './tools/expressPubSub';
import express from 'express';
import promiseLimit from './tools/promiseLimit';
import {Server} from 'http';
import qs from 'node:querystring';
import {appConfig} from './appConfig';
import {IncomingHttpHeaders} from 'node:http';
import {getDebug} from './tools/getDebug';
import {XmlDocument, XmlElement} from 'xmldoc';
import throttle from 'lodash.throttle';

const debug = getDebug('app:YtPubSub');
const oneLimit = promiseLimit(1);

class YtPubSub {
  private log = new LogFile('ytPubSub');
  private hubUrl = 'https://pubsubhubbub.appspot.com/subscribe';
  private host = appConfig.push.host || 'localhost';
  private port = appConfig.push.port;
  private expressPubSub = new ExpressPubSub({
    path: appConfig.push.path,
    secret: appConfig.push.secret,
    callbackUrl: appConfig.push.callbackUrl,
    leaseSeconds: appConfig.push.leaseSeconds,
  });
  private server: Server | undefined;
  private app = express();

  constructor(private main: Main) {}

  init() {
    this.expressPubSub.bind(this.app);
    this.expressPubSub.on('denied', (data: any) => {
      debug('Denied %o', data);
    });
    this.expressPubSub.on('feed', (data: PubSubFeed) => {
      this.handleFeed(data);
    });

    this.app.get('/isLive/:channelId', async (req, res) => {
      const {channelId} = req.params;
      const streams = (await this.main.db.getStreamsByChannelIds([channelId])).filter(
        (stream) => !stream.isOffline,
      );
      res.json({channelId, streams});
    });

    this.app.post('/isLive', express.json(), async (req, res) => {
      const ids = req.body;
      const streams = (await this.main.db.getStreamsByChannelIds(ids)).filter(
        (stream) => !stream.isOffline,
      );
      res.json({streams});
    });

    return new Promise<void>((resolve) => {
      this.server = this.app.listen(this.port, this.host, resolve);
    }).then(() => {
      this.startUpdateInterval();
      this.startCleanInterval();
    });
  }

  updateTimer: (() => void) | null = null;
  startUpdateInterval() {
    this.updateTimer && this.updateTimer();
    this.updateTimer = everyMinutes(appConfig.emitUpdateChannelPubSubSubscribeEveryMinutes, () => {
      this.updateSubscribes().catch((err: any) => {
        debug('updateSubscribes error', err);
      });
    });
  }

  cleanTimer: (() => void) | null = null;
  startCleanInterval() {
    this.cleanTimer && this.cleanTimer();
    this.cleanTimer = everyMinutes(appConfig.emitCleanPubSubFeedEveryHours * 60, () => {
      this.clean().catch((err: any) => {
        debug('clean error', err);
      });
    });
  }

  updateSubscribes = () => {
    return oneLimit(async () => {
      let subscribeCount = 0;
      let errorCount = 0;
      while (true) {
        const channelIds = await this.main.db.getYtPubSubChannelIdsWithExpiresSubscription();
        if (!channelIds.length) break;

        await this.main.db.setYtPubSubChannelsSubscriptionTimeoutExpiresAt(channelIds).then(() => {
          const expiresAt = new Date();
          expiresAt.setSeconds(expiresAt.getSeconds() + appConfig.push.leaseSeconds);

          const subscribedChannelIds: string[] = [];
          return parallel(10, channelIds, (id) => {
            return this.subscribe(id).then(
              () => {
                subscribedChannelIds.push(id);
                subscribeCount++;
              },
              (err: any) => {
                debug('subscribe channel %s skip, cause: %o', id, err);
                errorCount++;
              },
            );
          }).then(() => {
            return this.main.db.setYtPubSubChannelsSubscriptionExpiresAt(
              subscribedChannelIds,
              expiresAt,
            );
          });
        });
      }
      return {subscribeCount, errorCount};
    });
  };

  clean = async () => {
    return oneLimit(() => {
      return this.main.db.cleanYtPubSub().then((count) => {
        return {removedVideoIds: count};
      });
    });
  };

  subscribe(channelId: string) {
    const topicUrl = getTopicUrl(channelId);

    return this.expressPubSub.subscribe(topicUrl, this.hubUrl);
  }

  unsubscribe(channelId: string) {
    const topicUrl = getTopicUrl(channelId);

    return this.expressPubSub.unsubscribe(topicUrl, this.hubUrl);
  }

  feeds: Feed[] = [];
  emitFeedsChanges = () => {
    return oneLimit(async () => {
      while (this.feeds.length) {
        let feeds = this.feeds.splice(0);

        const feedIds: string[] = [];
        const channelIds: string[] = [];
        feeds.forEach((feed) => {
          channelIds.push(feed.channelId);
          feedIds.push(feed.id);
        });

        await Promise.all([
          this.main.db.getExistsYtPubSubChannelIds(channelIds),
          this.main.db.getExistsFeedIds(feedIds),
        ]).then(([existsChannelIds, existsFeedIds]) => {
          feeds = feeds.filter((feed) => existsChannelIds.includes(feed.channelId));

          return this.main.db.putFeeds(feeds).then(() => {
            feeds.forEach((feed) => {
              if (!existsFeedIds.includes(feed.id)) {
                this.log.write('[insert]', feed.channelId, feed.id);
              }
            });
          });
        });
      }
    });
  };
  emitFeedsChangesThrottled = throttle(this.emitFeedsChanges, 1000, {
    leading: false,
  });

  handleFeed(data: PubSubFeed) {
    try {
      const feed = parseData(data.feed.toString());

      const minPubDate = new Date();
      minPubDate.setDate(minPubDate.getDate() - 7);

      if (feed.publishedAt.getTime() > minPubDate.getTime()) {
        this.feeds.push(feed);
        this.emitFeedsChangesThrottled();
      }
    } catch (err: Error & any) {
      if (err.code === 'ENTRY_IS_DELETED') {
        // pass
      } else {
        debug('parseData skip, cause: %o', err);
      }
    }
  }

  async getStreams(channelIds: string[], skippedChannelIds: string[]) {
    return this.main.db
      .getNotExistsYtPubSubChannelIds(channelIds)
      .then((newChannelIds) => {
        if (!newChannelIds.length) return;
        const newChannels: YtPubSubChannel[] = newChannelIds.map((id) => {
          return {
            id,
            channelId: serviceId.wrap(this.main.youtube, id),
          };
        });
        return this.main.db.ensureYtPubSubChannels(newChannels).then(() => {
          return this.updateSubscribes();
        });
      })
      .then(() => {
        return this.syncChannels(channelIds, skippedChannelIds);
      })
      .then(() => {
        return this.syncStreams(channelIds);
      })
      .then(() => {
        return this.main.db.getStreamFeedsByChannelIds(channelIds);
      });
  }

  async syncChannels(channelIds: string[], skippedChannelIds: string[]) {
    const channelIdsForSync = await this.main.db.getYtPubSubChannelIdsForSync(channelIds);
    return parallel(1, arrayByPart(channelIdsForSync, 50), async (channelIdsForSync) => {
      const channels = await this.main.db.getYtPubSubChannelsByIds(channelIdsForSync);

      const channelIdChannel: Map<string, YtPubSubChannelModel> = new Map();
      channels.forEach((channel) => {
        channelIdChannel.set(channel.id, channel);
      });
      const channelIds = Array.from(channelIdChannel.keys());

      const syncAt = new Date();
      return this.main.db.setYtPubSubChannelsSyncTimeoutExpiresAt(channelIds).then(() => {
        const feeds: YtPubSubFeed[] = [];
        const channelIdsWithUpcoming: string[] = [];
        return parallel(10, channelIds, (channelId) => {
          const channel = channelIdChannel.get(channelId)!;
          return this.requestFeedsByChannelId(channelId, channel.isUpcomingChecked).then(
            ({withUpcoming, feeds: channelFeeds}) => {
              if (withUpcoming) {
                channelIdsWithUpcoming.push(channelId);
              }
              feeds.push(...channelFeeds);
            },
            (err) => {
              debug(`getStreams for channel (%s) skip, cause: %o`, channelId, err);
              skippedChannelIds.push(channelId);
            },
          );
        }).then(async () => {
          const feedIds = feeds.map((feed) => feed.id);
          const existsFeeds = await this.main.db.getExistsFeeds(feedIds);

          const existsIsStreamTrueIds: string[] = [];
          const existsIsStreamFalseIds: string[] = [];
          const existsFeedIds: string[] = [];
          existsFeeds.forEach((feed) => {
            if (feed.isStream !== null) {
              if (feed.isStream) {
                existsIsStreamTrueIds.push(feed.id);
              } else {
                existsIsStreamFalseIds.push(feed.id);
              }
            }
            existsFeedIds.push(feed.id);
          });

          const notExistFeeds: YtPubSubFeed[] = [];
          const fixedIsStreamFeeds: YtPubSubFeed[] = [];
          feeds.forEach((feed) => {
            if (!existsFeedIds.includes(feed.id)) {
              notExistFeeds.push(feed);
            } else if (existsIsStreamFalseIds.includes(feed.id)) {
              fixedIsStreamFeeds.push(feed);
              feed.isStream = null;
            } else if (existsIsStreamTrueIds.includes(feed.id)) {
              feed.isStream = true;
            }
          });

          await Promise.all([
            this.main.db.putFeeds(feeds),
            this.main.db.setYtPubSubChannelsLastSyncAt(channelIds, syncAt),
            this.main.db.setYtPubSubChannelsUpcomingChecked(channelIdsWithUpcoming),
          ]);

          notExistFeeds.forEach((feed) => {
            this.log.write('[insert full]', feed.channelId, feed.id);
          });

          fixedIsStreamFeeds.forEach((feed) => {
            this.log.write('[fixed]', feed.channelId, feed.id);
          });
        });
      });
    });
  }

  async syncStreams(channelIds: string[]) {
    const feedIdsForSync = await this.main.db.getFeedIdsForSync(channelIds);
    return parallel(10, arrayByPart(feedIdsForSync, 50), async (feedIdsForSync) => {
      const feeds = await this.main.db.getFeedsByIds(feedIdsForSync);

      const feedIdFeed: Map<string, YtPubSubFeed> = new Map();
      feeds.forEach((feed) => {
        feedIdFeed.set(feed.id, feed.get({plain: true}) as YtPubSubFeed);
      });
      const feedIds = Array.from(feedIdFeed.keys());

      return this.main.db
        .setFeedsSyncTimeoutExpiresAt(feedIds)
        .then(() => {
          return this.main.youtube.getStreamIdLiveDetaildByIds(feedIds);
        })
        .then((idStreamLiveDetails) => {
          const feedIdChanges: {[s: string]: YtPubSubFeed} = {};
          const notStreamIds = arrayDifference(feedIds, Array.from(idStreamLiveDetails.keys()));

          idStreamLiveDetails.forEach((info, id) => {
            const feed = feedIdFeed.get(id);
            if (!feed) {
              debug('Skip info %s, cause: feed is not found', id);
              return;
            }
            feed.isStream = true;
            Object.assign(feed, info);
            feedIdChanges[feed.id] = feed;
          });

          notStreamIds.forEach((id) => {
            const feed = feedIdFeed.get(id)!;
            if (feed.isStream) {
              this.log.write('[not found]', feed.channelId, feed.id);
            }
            feed.isStream = false;
            feedIdChanges[feed.id] = feed;
          });

          return this.main.db.updateFeeds(Object.values(feedIdChanges));
        });
    });
  }

  requestFeedsByChannelId(channelId: string, isUpcomingChecked: boolean | undefined) {
    const feeds: YtPubSubFeed[] = [];

    let withUpcoming: null | boolean = null;
    const promises = [];
    if (!isUpcomingChecked) {
      withUpcoming = true;
      promises.push(
        this.main.youtube.getStreamIdSnippetByChannelId(channelId, true).catch((err) => {
          withUpcoming = false;
          debug('Get upcoming feeds %s error: %o', channelId, err);
          return null;
        }),
      );
    }
    promises.push(this.main.youtube.getStreamIdSnippetByChannelId(channelId));

    return Promise.all(promises)
      .then((results) => {
        results.forEach((streamIdSnippet) => {
          if (streamIdSnippet === null) return;

          streamIdSnippet.forEach((snippet, id) => {
            feeds.push({
              id,
              title: snippet.title,
              channelId: snippet.channelId,
              channelTitle: snippet.channelTitle,
            });
          });
        });
      })
      .then(() => {
        return {
          withUpcoming,
          feeds,
        };
      });
  }
}

interface PubSubFeed {
  topic: string | undefined;
  hub: string | undefined;
  callback: string;
  feed: Buffer;
  headers: IncomingHttpHeaders;
}

interface Feed {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: Date;
}

function parseData(xml: string): Feed {
  const document = new XmlDocument(xml);

  const entry = getChildNode(document, 'entry');
  if (!entry) {
    const isDeletedEntry = !!getChildNode(document, 'at:deleted-entry');
    if (isDeletedEntry) {
      throw new ErrorWithCode('Entry deleted!', 'ENTRY_IS_DELETED');
    }
  }

  try {
    if (!entry) {
      throw new ErrorWithCode('Entry is not found!', 'ENTRY_IS_NOT_FOUND');
    }

    const data: {[s: string]: string} = {};
    const success = ['yt:videoId', 'yt:channelId', 'title', 'author', 'published'].every(
      (field) => {
        let node = getChildNode(entry, field);
        if (node && field === 'author') {
          node = getChildNode(node, 'name');
        }
        if (node) {
          data[field] = node.val;
          return true;
        }
      },
    );
    if (!success) {
      throw new ErrorWithCode('Some fields is not found', 'SOME_FIELDS_IS_NOT_FOUND');
    }

    return {
      id: data['yt:videoId'],
      title: data.title,
      channelId: data['yt:channelId'],
      channelTitle: data.author,
      publishedAt: new Date(data.published),
    };
  } catch (err) {
    debug(
      'parseData error, cause: Some data is not found %j',
      document.toString({compressed: true}),
    );
    throw err;
  }
}

function getTopicUrl(channelId: string) {
  return (
    'https://www.youtube.com/xml/feeds/videos.xml' +
    '?' +
    qs.stringify({
      channel_id: channelId,
    })
  );
}

function getChildNode(root: XmlElement | XmlDocument, name: string): XmlElement | null {
  if (root.children) {
    for (let i = 0, node; (node = root.children[i]); i++) {
      if ('name' in node && node.name === name) {
        return node;
      }
    }
  }
  return null;
}

export default YtPubSub;
