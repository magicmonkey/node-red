/**
 * Copyright 2013 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
var util = require("util");
var mqtt = require("mqtt");
var events = require("events");

//var Client = module.exports.Client = function(
   
var port = 1883;
var host = "localhost";

function MQTTClient(port,host) {
   this.port = port||1883;
   this.host = host||"localhost";
   this.messageId = 1;
   this.pendingSubscriptions = {};
   this.inboundMessages = {};
   this.lastOutbound = (new Date()).getTime();
   this.lastInbound = (new Date()).getTime();
   this.connected = false;
   
   this._nextMessageId = function() {
      this.messageId += 1;
      if (this.messageId > 0xFFFF) {
         this.messageId = 1;
      }
      return this.messageId;
   }
   events.EventEmitter.call(this);
}
util.inherits(MQTTClient, events.EventEmitter);

MQTTClient.prototype.connect = function(options) {
   var self = this;
   options = options||{};
   self.options = options;
   self.options.keepalive = options.keepalive||15;
   self.options.clean = self.options.clean||true;
   self.options.protocolId = 'MQIsdp';
   self.options.protocolVersion = 3;
   
   self.client = mqtt.createConnection(this.port,this.host,function(err,client) {
         if (err) {
            self.emit('connectionlost',err);
            return;
         }
         client.on('close',function(e) {
               clearInterval(self.watchdog);
               if (self.connected) {
                  self.connected = false;
                  self.emit('connectionlost',e);
               } else {
                  self.emit('disconnect');
               }
         });
         client.on('error',function(e) {
               clearInterval(self.watchdog);
               if (self.connected) {
                  self.connected = false;
                  self.emit('connectionlost',e);
               }
         });
         client.on('connack',function(packet) {
               if (packet.returnCode == 0) {
                  self.watchdog = setInterval(function(self) {
                        var now = (new Date()).getTime();
                        if (now - self.lastOutbound > self.options.keepalive*500 || now - self.lastInbound > self.options.keepalive*500) {
                           if (self.pingOutstanding) {
                               self.client.disconnect();
                           } else {
                              self.lastOutbound = (new Date()).getTime();
                              self.lastInbound = (new Date()).getTime();
                              self.pingOutstanding = true;
                              self.client.pingreq();
                           }
                        }
                        
                  },self.options.keepalive*500,self);
                  self.pingOutstanding = false;
                  self.lastInbound = (new Date()).getTime()
                  self.lastOutbound = (new Date()).getTime()
                  self.connected = true;
                  self.emit('connect');
               } else {
                  self.connected = false;
                  self.emit('connectionlost');
               }
         });
         client.on('suback',function(packet) {
               self.lastInbound = (new Date()).getTime()
               var topic = self.pendingSubscriptions[packet.messageId];
               self.emit('subscribe',topic,packet.granted[0]);
               delete self.pendingSubscriptions[packet.messageId];
         });
         client.on('unsuback',function(packet) {
               self.lastInbound = (new Date()).getTime()
               var topic = self.pendingSubscriptions[packet.messageId];
               self.emit('unsubscribe',topic,packet.granted[0]);
               delete self.pendingSubscriptions[packet.messageId];
         });
         client.on('publish',function(packet) {
               self.lastInbound = (new Date()).getTime()
               if (packet.qos < 2) {
                  var p = packet;
                  self.emit('message',p.topic,p.payload,p.qos,p.retain);
               } else {
                  self.inboundMessages[packet.messageId] = packet;
                  this.lastOutbound = (new Date()).getTime()
                  self.client.pubrec(packet);
               }
               if (packet.qos == 1) {
                  this.lastOutbound = (new Date()).getTime()
                  self.client.puback(packet);
               }
         });
         
         client.on('pubrel',function(packet) {
               self.lastInbound = (new Date()).getTime()
               var p = self.inboundMessages[packet.messageId];
               self.emit('message',p.topic,p.payload,p.qos,p.retain);
               delete self.inboundMessages[packet.messageId];
               self.lastOutbound = (new Date()).getTime()
               self.client.pubcomp(packet);
         });
         
         client.on('puback',function(packet) {
               self.lastInbound = (new Date()).getTime()
               // outbound qos-1 complete
         });
         
         client.on('pubrec',function(packet) {
               self.lastInbound = (new Date()).getTime()
               self.lastOutbound = (new Date()).getTime()
               self.client.pubrel(packet);
         });
         client.on('pubcomp',function(packet) {
               self.lastInbound = (new Date()).getTime()
               // outbound qos-2 complete
         });
         client.on('pingresp',function(packet) {
               self.lastInbound = (new Date()).getTime()
               self.pingOutstanding = false;
         });
         
         this.lastOutbound = (new Date()).getTime()
         client.connect(self.options);
   });
}

MQTTClient.prototype.subscribe = function(topic,qos) {
   var self = this;
   if (self.connected) {
      var options = {
         subscriptions:[{topic:topic,qos:qos}],
         messageId: self._nextMessageId()
      };
      this.pendingSubscriptions[options.messageId] = topic;
      this.lastOutbound = (new Date()).getTime()
      self.client.subscribe(options);
   }
}
MQTTClient.prototype.unsubscribe = function(topic) {
   var self = this;
   if (self.connected) {
      var options = {
         topic:topic,
         messageId: self._nextMessageId()
      };
      this.pendingSubscriptions[options.messageId] = topic;
      this.lastOutbound = (new Date()).getTime()
      self.client.unsubscribe(options);
   }
}

MQTTClient.prototype.publish = function(topic,payload,qos,retain) {
   var self = this;
   if (self.connected) {
   
      if (Buffer.isBuffer(payload)) {
         payload = payload.toString();
      } else if (typeof payload === "object") {
         payload = JSON.stringify(payload);
      } else if (typeof payload !== "string") {
         payload = ""+payload;
      }
      var options = {
         topic: topic,
         payload: payload,
         qos: qos||0,
         retain:retain||false
      };
      if (options.qos != 0) {
         options.messageId = self._nextMessageId();
      }
      this.lastOutbound = (new Date()).getTime()
      self.client.publish(options);
   }
}

MQTTClient.prototype.disconnect = function() {
   var self = this;
   if (this.connected) {
       this.connected = false;
       this.client.disconnect();
   }
}
MQTTClient.prototype.isConnected = function() {
    return this.connected;
}
module.exports.createClient = function(port,host) {
   var mqtt_client = new MQTTClient(port,host);
   return mqtt_client;
}

