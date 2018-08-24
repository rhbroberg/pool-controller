/* global jQuery io Mustache moment */

var socket = io();

function scrollToBottom(whichForm) {
    // selectors
    var messages = jQuery(whichForm);
    var newMessage = messages.children('li:last-child');

    // heights
    var clientHeight = messages.prop('clientHeight');
    var scrollTop = messages.prop('scrollTop');
    var scrollHeight = messages.prop('scrollHeight');
    var newMessageHeight = newMessage.innerHeight();
    var lastMessageHeight = newMessage.prev().innerHeight();

    if (clientHeight + scrollTop + newMessageHeight + lastMessageHeight >= scrollHeight) {
        messages.scrollTop(scrollHeight);
    }
}
socket.on('info', function(cleartext) {
    const message = JSON.parse(cleartext);

    console.log('got info', message.text);
    var template = jQuery('#info-template').html();

    for (var i = 0; i < message.text.length; i++) {
        var html = Mustache.render(template, {
            name: message.text[i].name,
            value: message.text[i].value,
            timestamp: moment(message.timestamp).format('YYYY-MM-DDTHH:mm:ss')
        });

        jQuery('#info__crawl').append(html);
    }
});
socket.on('status', function(cleartext) {
    const message = JSON.parse(cleartext);
    var template = jQuery('#status-template').html();

    var html = Mustache.render(template, {
        nowEnabled: message.text.nowEnabled,
        nowDisabled: message.text.nowDisabled,
        timestamp: moment(message.timestamp).format('YYYY-MM-DDTHH:mm:ss')
    });

    console.log('got status', message.text);
    jQuery('#status__crawl').append(html);
});
socket.on('control', function(cleartext) {
    const message = JSON.parse(cleartext);
    var template = jQuery('#status-template').html();

    for (var i = 0; i < message.text.length; i++) {
        var html = Mustache.render(template, {
            nowEnabled: message.text[i],
            timestamp: moment(message.timestamp).format('YYYY-MM-DDTHH:mm:ss')
        });

        jQuery('#control__crawl').append(html);
        scrollToBottom('#control__crawl');
    }

    console.log('got control', message.text);
});
