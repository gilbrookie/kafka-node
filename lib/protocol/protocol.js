'use strict';

var Binary = require('binary'),
    Buffermaker = require('buffermaker'),
    _  = require('underscore'),
    crc32 = require('buffer-crc32'),
    protocol = require('./protocol_struct'),
    KEYS = protocol.KEYS,
    FetchResponse = protocol.FetchResponse,
    PartitionMetadata = protocol.PartitionMetadata;

var REQUEST_TYPE = {
    produce: 0,
    fetch: 1,
    offset: 2,
    metadata: 3,
    leader: 4,
    stopReplilca: 5,
    offsetCommit: 6,
    offsetFetch: 7
};

var API_VERSION = 0,
    REPLICA_ID = -1;

function groupByTopic(payloads) {
    return payloads.reduce(function (out, p) { 
        out[p.topic] = out[p.topic] || {};
        out[p.topic][p.partition] = p;
        return out;
    }, {});
}

function encodeRequestWithLength(request) {
    return new Buffermaker()
                .UInt32BE(request.length)
                .string(request)
                .make();
}

function encodeRequestHeader(clientId, correlationId, apiKey) {
    return new Buffermaker()
                .UInt16BE(apiKey)
                .UInt16BE(API_VERSION)
                .UInt32BE(correlationId)
                .UInt16BE(clientId.length)
                .string(clientId);
}

function encodeFetchRequest(maxWaitMs, minBytes) {
    return function (clientId, correlationId, payloads) {
        return _encodeFetchRequest(clientId, correlationId, payloads, maxWaitMs, minBytes);
    }
}

function _encodeFetchRequest(clientId, correlationId, payloads, maxWaitMs, minBytes) {
    payloads = groupByTopic(payloads);
    var request = encodeRequestHeader(clientId, correlationId, REQUEST_TYPE.fetch);
    var topics = Object.keys(payloads);

    request.Int32BE(REPLICA_ID)
            .UInt32BE(maxWaitMs)
            .UInt32BE(minBytes)
            .UInt32BE(topics.length);

    topics.forEach(function (topic) {
        request.UInt16BE(topic.length)
                .string(topic);

        var partitions = _.pairs(payloads[topic]).map(function (pairs) { return pairs[1] });
        request.UInt32BE(partitions.length);
        partitions.forEach(function (p) {
            request.UInt32BE(p.partition)
                    .Int64BE(p.offset)
                    .UInt32BE(p.maxBytes);
        });
    });

    return encodeRequestWithLength(request.make());
}

function decodeFetchResponse(resp) {
    var cur = 4 + 4 + 4,
        fetchResponse = new FetchResponse(),
        responses = [];
    var topicNum = Binary.parse(resp)
                    .word32bu('size')
                    .word32bu('correlationId')
                    .word32bu('topicNum')
                    .vars.topicNum;
    resp = resp.slice(cur);
    
    for (var i=0; i< topicNum; i++) {
        cur = 2 + 4;
        var topic = Binary.parse(resp)
                            .word16bu('topic')
                            .tap(function (vars) {
                                cur += vars.topic;
                                this.buffer('topic', vars.topic);
                            })
                            .word32bu('partitionNum')
                            .vars;
        resp = resp.slice(cur);
        fetchResponse.topic = topic.topic;
        fetchResponse.fetchPartitions = fetchResponse.fetchPartitions || [];
        for(var j=0; j<topic.partitionNum; j++) {
            cur = 4 + 2 + 8 + 4;
            var vars  = Binary.parse(resp)
                                .word32bu('partition')
                                .word16bu('errorCode')
                                .word64bu('highWaterOffset')
                                .word32bu('messageSetSize')
                                .tap(function (vars) {
                                    cur += vars.messageSetSize;
                                    this.buffer('messageSet', vars.messageSetSize)
                                })
                                .vars;

            vars.messageSet = decodeMessageSet(vars.messageSet);
            fetchResponse.fetchPartitions.push(vars);
            resp = resp.slice(cur);
        }
        responses.push(fetchResponse);
    }
    return responses;
}

function decodeMessageSet(messageSet) {
    var set = [];
    while (messageSet.length > 0) {
        var cur = 8 + 4;
        var vars = Binary.parse(messageSet)
            .word64bu('offset')
            .word32bu('messageSize')
            .tap(function (vars) {
                cur += vars.messageSize;
                this.buffer('message', vars.messageSize);
            })
            .vars;

        messageSet = messageSet.slice(cur);
        vars.message = decodeMessage(vars.message);
        set.push(vars);
    }
    return set;
}

function decodeMessage(message) {
    var message = Binary.parse(message)
                    .word32bu('crc')
                    .word8bu('magicByte')
                    .word8bu('attributes')
                    .word32bs('key')
                    .tap(function (vars) {
                        if (vars.key == -1)  return;
                        this.buffer('key', vars.key);
                    })
                    .word32bu('value')
                    .tap(function (vars) {
                        if (vars.value == -1)  return;
                        this.buffer('value', vars.value);
                    })
                    .vars;
    return message;
}

function encodeMetadataRequest(clientId, correlationId, topics) {
    var request = encodeRequestHeader(clientId, correlationId, REQUEST_TYPE.metadata);
    request.Int32BE(topics.length);
    topics.forEach(function (topic) {
        request.Int16BE(topic.length)
                .string(topic);
    });
    return encodeRequestWithLength(request.make());
}

function decodeMetadataResponse(resp) {
    var cur = 4 + 4 + 4;
    var brokerNum = Binary.parse(resp)
        .word32bu('size')
        .word32bu('correlationId')
        .word32bu('brokerNum')
        .vars.brokerNum;
    resp = resp.slice(cur);
    var decoded = decodeBrokers(brokerNum, resp);
    var brokers = decoded[0];
    resp = decoded[1];
    var topicMetadatas = decodeTopicMetadatas(resp);
    return [brokers, topicMetadatas];
}

function decodeBrokers(brokerNum, resp) {
    var brokers = {},cur;
    for (var i=0; i<brokerNum; i++) {
        cur = 4 + 2 +4;
        var broker = Binary.parse(resp)
            .word32bu('nodeId')
            .word16bu('host')
            .tap(function (vars) { 
                cur += vars.host;
                this.buffer('host', vars.host)
                vars.host = vars.host.toString();
            })
            .word32bu('port')
            .vars;
        resp = resp.slice(cur);
        brokers[broker.nodeId] = broker;
    }
    return [brokers, resp];
}

function decodeTopicMetadatas(resp) {
    var topicMetadata = {},
        cur,
        topicNum = Binary.parse(resp).word32bu('num').vars.num;
    resp = resp.slice(4);
    for(var i=0; i<topicNum; i++) {
        cur = 2 + 2 + 4;
        var topic = Binary.parse(resp)
            .word16bu('topicError')
            .word16bu('topicName')
            .tap(function (vars) {
                cur += vars.topicName;
                this.buffer('topicName', vars.topicName);
            })
            .word32bu('partitionNum')
            .vars;
        resp = resp.slice(cur);
        
        var partitionMetadata = {}
        for (var j=0; j<topic.partitionNum; j++) {
            cur = 2 + 4 + 4 + 4 + 4;
            var p = Binary.parse(resp)
                .word16bu('errorCode')
                .word32bu('partition')
                .word32bu('leader')
                .word32bu('replicasNum')
                .tap(function (vars) {
                    cur += vars.replicasNum * 4;
                    var buffer = this.buffer('replicas', vars.replicasNum * 4).vars.replicas; 
                    this.vars.replicas = bufferToArray(vars.replicasNum, buffer);
                })
                .word32bu('isrNum')
                .tap(function (vars) {
                    cur += vars.isrNum * 4;
                    var buffer = this.buffer('isr', vars.isrNum * 4).vars.isr;
                    this.vars.isr = bufferToArray(vars.isrNum, buffer);
                }).vars;
            
            resp = resp.slice(cur);
            partitionMetadata[p.partition] = 
                new PartitionMetadata(topic.topicName, p.partition, p.leader, p.replicas, p.isr);
        }
        topicMetadata[topic.topicName] = partitionMetadata;
    }
    return topicMetadata;
}

function bufferToArray(num, buffer) {
    var ret = []
    for(var i=0; i< num; i++) {
        ret.push(Binary.parse(buffer).word32bu('r').vars.r);
        buffer = buffer.slice(4);
    }
    return ret;
}

function _encodeOffsetCommitRequest(clientId, correlationId, group, payloads) {
    payloads = groupByTopic(payloads);
    var request = encodeRequestHeader(clientId, correlationId, REQUEST_TYPE.offsetCommit);
    var topics = Object.keys(payloads);

    request.UInt16BE(group.length)
            .string(group)
            .UInt32BE(topics.length);

    topics.forEach(function (topic) {
        request.UInt16BE(topic.length)
                .string(topic);

        var partitions = _.pairs(payloads[topic]).map(function (pairs) { return pairs[1] });
        request.UInt32BE(partitions.length);
        partitions.forEach(function (p) {
            request.UInt32BE(p.partition)
                    .Int64BE(p.offset)
                    .UInt16BE(p.metadata.length)
                    .string(p.metadata);
        });
    });

    return encodeRequestWithLength(request.make());
}

function encodeOffsetCommitRequest(group) {
    return function (clientId, correlationId, payloads) {
        return _encodeOffsetCommitRequest(clientId, correlationId, group, pyaloads);
    }
}

function decodeOffsetCommitResponse(resp) {
    var vars = Binary.parse(resp)
                .word32bu('correlationId')
                .word16bu('clientId')
                .tap(function (vars) {
                    this.buffer('clientId', vars.clientId)
                })
                .word32bu('topicNum')
                .vars;
    var topicNum = vars.topicNum;
    var cur = 4 + 4;
    resp = resp.slice(cur);
    
    for (var i=0; i<topicNum; i++) {
        cur = 2 + 4;
        var topic = Binary.parse(resp)
                    .word16bu('topic')
                    .tap(function (vars) {
                        cur += vars.topic;
                        this.buffer('topic', vars.topic);
                    })
                    .word32bu('partitionNum')
                    .vars;
        resp = resp.slice(cur);

        for (var j=0; j<topic.partitionNum; j++) {
            cur = 4 + 2;
            var partition = Binary.parse(resp)
                            .word32bu('partition')
                            .word16bu('errorCode')
                            .vars;
            resp = resp.slice(cur);
        } 
    }
}

function encodeProduceRequest(requireAcks, ackTimeoutMs) {
    return function (clientId, correlationId, payloads) {
        return _encodeProduceRequest(clientId, correlationId, payloads, requireAcks, ackTimeoutMs);
    }
}

function _encodeProduceRequest(clientId, correlationId, payloads, requireAcks, ackTimeoutMs) {
    payloads = groupByTopic(payloads);
    var request = encodeRequestHeader(clientId, correlationId, REQUEST_TYPE.produce);
    var topics = Object.keys(payloads);
    request.UInt16BE(requireAcks)
        .UInt32BE(ackTimeoutMs)
        .UInt32BE(topics.length);

    topics.forEach(function (topic) {
        request.UInt16BE(topic.length)
               .string(topic);

        var reqs = _.pairs(payloads[topic]).map(function (pairs) { return pairs[1] });
        request.UInt32BE(reqs.length);
        reqs.forEach(function (p) {
            var messageSet = encodeMessageSet(p.messages);
            request.UInt32BE(p.partition)
                .UInt32BE(messageSet.length)
                .string(messageSet);
        });
    });

    return encodeRequestWithLength(request.make());
}

function encodeMessageSet(messageSet) {
    var buffer = new Buffermaker();
    messageSet.forEach(function (message) {
        var msg = encodeMessage(message);
        buffer.Int64BE(0)
            .UInt32BE(msg.length)
            .string(msg);
    });
    return buffer.make();
}

function encodeMessage(message) {
    var m = new Buffermaker()
        .UInt8(message.magic)
        .UInt8(message.attributes)
        .UInt32BE(message.key.length)
        .string(message.key)
        .UInt32BE(message.value.length)
        .string(message.value).make();
    var crc = crc32.unsigned(m);
    return new Buffermaker()
        .UInt32BE(crc)
        .string(m)
        .make();
}

function decodeProduceResponse(resp) {
    var vars = Binary.parse(resp)
        .word32bu('size')
        .word32bu('correlationId')
        .word32bu('topicNum')
        .vars;
    var cur = 4 + 4 + 4;
    resp = resp.slice(cur);
    for (var i=0; i<vars.topicNum; i++) {
        cur = 2 + 4;
        var topic = Binary.parse(resp)
            .word16bu('topic')
            .tap(function (vars) {
                cur += vars.topic;
                this.buffer('topic', vars.topic)
            })
            .word32bu('partitionNum').vars;
        resp = resp.slice(cur);

        for(var j=0; j<topic.partitionNum; j++) {
            cur = 4 + 2 + 8;
            var partition = Binary.parse(resp)
                .word32bu('partition')
                .word16bu('errorCode')
                .word64bu('offset').vars;
            resp = resp.slice(cur);
            vars.partition = partition;
        }
    }
    return vars;
}

exports.encodeFetchRequest = encodeFetchRequest;
exports.decodeFetchResponse = decodeFetchResponse;
exports.encodeOffsetCommitRequest = encodeOffsetCommitRequest;
exports.decodeOffsetCommitResponse = decodeOffsetCommitResponse;
exports.encodeMetadataRequest = encodeMetadataRequest;
exports.decodeMetadataResponse = decodeMetadataResponse;
exports.encodeProduceRequest = encodeProduceRequest;
exports.decodeProduceResponse = decodeProduceResponse;