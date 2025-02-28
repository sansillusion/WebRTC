class WebRTCCamera extends HTMLElement {
    subscriptions = [];
    rendered = false;

    async initMSE(hass, pc = null) {
        const ts = Date.now();

        const data = await hass.callWS({
            type: 'auth/sign_path',
            path: '/api/webrtc/ws'
        });

        let url = 'ws' + hass.hassUrl(data.path).substr(4);
        if (this.config.url) url += '&url=' + encodeURIComponent(this.config.url);
        if (this.config.entity) url += '&entity=' + this.config.entity;

        const video = this.querySelector('#video');
        const ws = this.ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';

        let mediaSource, sourceBuffer;
        
        this.subscriptions.push(() => {
            this.ws.onclose = null;
            this.ws.close();
            console.debug("Closing websocket");
        });

        ws.onopen = async () => {
            this.readyState = 'websocket';

            if (this.config.mse !== false && 'MediaSource' in window) {
                mediaSource = new MediaSource();
                video.src = URL.createObjectURL(mediaSource);
                video.srcObject = null;

                mediaSource.onsourceopen = () => {
                    ws.send(JSON.stringify({type: 'mse'}));
                }
            } else {
                console.warn("MediaSource doesn't supported")
            }

            if (this.config.webrtc !== false && !this.isOpera) {
                this.readyState = 'webrtc-pending';

                if (!pc) pc = this.initWebRTC(hass);

                const offer = await pc.createOffer({iceRestart: true})
                await pc.setLocalDescription(offer);
                this.subscriptions.push(() => {
                    pc.close();
                    pc = null;
                    console.debug("Closing RTCPeerConnection");
                });
            }
        }
        ws.onmessage = ev => {
            if (typeof ev.data === 'string') {
                const data = JSON.parse(ev.data);
                if (data.type === 'mse') {
                    console.debug("Received MSE codecs:", data.codecs);

                    try {
                        sourceBuffer = mediaSource.addSourceBuffer(
                            `video/mp4; codecs="${data.codecs}"`);
                        this.readyState = 'mse';
                    } catch (e) {
                        this.status = `ERROR: ${e}`;
                    }
                } else if (data.type === 'webrtc') {
                    console.debug("Received WebRTC SDP");

                    // remove docker IP-address
                    const sdp = data.sdp.replace(
                        /a=candidate.+? 172\.\d+\.\d+\.1 .+?\r\n/g, ''
                    );
                    pc.setRemoteDescription(
                        new RTCSessionDescription({
                            type: 'answer', sdp: sdp
                        })
                    );
                } else if (data.error) {
                    this.status = `ERROR: ${data.error}`;
                }
            } else if (sourceBuffer) {
                if (!sourceBuffer.updating) {
                    sourceBuffer.appendBuffer(ev.data);
                }
                // all the magic is here
                if (!video.paused && video.seekable.length) {
                    if (video.seekable.end(0) - video.currentTime > 0.5) {
                        console.debug("Auto seek to livetime");
                        video.currentTime = video.seekable.end(0);
                    }
                }
            }
        }
        ws.onclose = () => {
            // reconnect no more than once every 15 seconds
            const delay = 15000 - Math.min(Date.now() - ts, 15000);
            console.debug(`Reconnect in ${delay} ms`);

            setTimeout(() => {
                if (this.isConnected) {
                    this.status = "Restart connection";
                    this.initMSE(hass, pc);
                }
            }, delay);
        }
    }

    initWebRTC(hass) {
        const video = document.createElement('video');
        video.onloadeddata = () => {
            if (video.readyState >= 1) {
                console.debug("Switch to WebRTC")

                const mainVideo = this.querySelector('#video');
                mainVideo.srcObject = video.srcObject;

                // disable autorestart ws connection
                this.ws.onclose = null;
                this.ws.close();

                this.readyState = 'webrtc';
            }
        }

        const pc = new RTCPeerConnection({
            iceServers: this.config.ice_servers || [{
                urls: 'stun:stun.l.google.com:19302'
            }],
            iceCandidatePoolSize: 20
        });

        pc.onicecandidate = async (ev) => {
            if (ev.candidate) return;

            try {
                // only for debug purpose
                const iceTransport = pc.getSenders()[0].transport.iceTransport;
                iceTransport.onselectedcandidatepairchange = () => {
                    const pair = iceTransport.getSelectedCandidatePair();
                    const type = pair.remote.type === 'host' ? 'LAN' : 'WAN';

                    this.readyState = 'webrtc-connecting';
                    // this.status = `Connecting over ${type}`;
                    console.debug(`Connecting over ${type}`);
                }
            } catch (e) {
                // Hi to Safari and Firefox...
            }

            // this.status = "Trying to start stream";

            try {
                this.ws.send(JSON.stringify({
                    type: 'webrtc',
                    sdp: pc.localDescription.sdp
                }));
            } catch (e) {
                console.warn(e);
            }
        }

        pc.ontrack = (ev) => {
            if (video.srcObject === null) {
                video.srcObject = ev.streams[0];
            } else {
                video.srcObject.addTrack(ev.track);
            }
        }

        pc.onconnectionstatechange = async (ev) => {
            // https://developer.mozilla.org/en-US/docs/Web/API/RTCOfferOptions/iceRestart
            console.debug("WebRTC state:", pc.connectionState);
            if (pc.connectionState === 'failed') {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.readyState = 'webrtc-restart';
                    // this.status = "Restart connection";

                    const offer = await pc.createOffer({iceRestart: true})
                    await pc.setLocalDescription(offer);
                } else {
                    if (this.isConnected) {
                        video.src = '';
                        this.initMSE(hass, pc);
                    }
                }
            } else if (pc.connectionState === 'connected') {
                this.readyState = 'webrtc-loading';
                // this.status = "Loading video";
            }
        }

        // https://stackoverflow.com/questions/9847580/how-to-detect-safari-chrome-ie-firefox-and-opera-browser
        const isFirefox = typeof InstallTrigger !== 'undefined';

        // recvonly don't work with Firefox
        // https://github.com/pion/webrtc/issues/717
        // sendrecv don't work with some Android mobile phones and tablets
        // and Firefox can't play video with Bunny even with sendrecv
        const direction = !isFirefox ? 'recvonly' : 'sendrecv';

        pc.addTransceiver('video', {'direction': direction});
        if (this.config.audio !== false) {
            pc.addTransceiver('audio', {'direction': direction});
        }

        return pc;
    }

    renderCustomGUI(card) {
        const video = this.querySelector('#video');
        video.controls = false;
        video.style.pointerEvents = 'none';
        video.style.opacity = 0;

        const spinner = document.createElement('ha-circular-progress');
        spinner.active = true;
        spinner.className = 'spinner'
        card.appendChild(spinner);

        const pause = document.createElement('ha-icon');
        pause.className = 'pause';
        pause.icon = 'mdi:pause';
        pause.onclick = () => {
            if (video.paused) {
                video.play().then(() => null, () => null);
            } else {
                video.pause();
            }
        };
        card.appendChild(pause);

        const volume = document.createElement('ha-icon');
        volume.className = 'volume';
        volume.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';
        volume.onclick = () => {
            video.muted = !video.muted;
        };
        card.appendChild(volume);

        video.onvolumechange = () => {
            volume.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';
        };

        const fullscreen = document.createElement('ha-icon');
        fullscreen.className = 'fullscreen';
        fullscreen.icon = 'mdi:fullscreen';

        // https://stackoverflow.com/questions/43024394/ios10-fullscreen-safari-javascript
        if (this.requestFullscreen) {  // normal browser
            fullscreen.onclick = () => {
                document.fullscreenElement
                    ? document.exitFullscreen() : this.requestFullScreen();
            }
            this.onfullscreenchange = () => {
                fullscreen.icon = document.fullscreenElement
                    ? 'mdi:fullscreen-exit' : 'mdi:fullscreen';
            }
        } else {  // Apple Safari...
            fullscreen.onclick = () => {
                document.webkitFullscreenElement
                    ? document.webkitExitFullscreen()
                    : this.webkitRequestFullScreen();
            }
            this.onwebkitfullscreenchange = () => {
                fullscreen.icon = document.webkitFullscreenElement
                    ? 'mdi:fullscreen-exit' : 'mdi:fullscreen';
            }
        }
        // iPhone doesn't support fullscreen
        if (navigator.platform !== 'iPhone') card.appendChild(fullscreen);

        video.addEventListener('loadeddata', () => {
            const hasAudio =
                (video.srcObject && video.srcObject.getAudioTracks().length) ||
                video.mozHasAudio || video.webkitAudioDecodedByteCount ||
                (video.audioTracks && video.audioTracks.length);
            volume.style.display = hasAudio ? 'block' : 'none';
            pause.style.display = 'block';
            video.style.opacity = 1;
        });
        video.onpause = () => {
            pause.icon = 'mdi:play';
            this.setPTZVisibility(false);
        };
        video.onplay = () => {
            pause.icon = 'mdi:pause';
            this.setPTZVisibility(true);
        };
        video.onwaiting = () => {
            spinner.style.display = 'block';
            this.setPTZVisibility(false);
        };
        video.onplaying = () => {
            spinner.style.display = 'none';
            this.setPTZVisibility(true);
        };
    }

    renderPTZ(card, hass) {
        const ptz = document.createElement('div');
        ptz.className = 'ptz';
        ptz.style.opacity = this.config.ptz.opacity || '0.4';
        const ptzMove = document.createElement('div');
        ptzMove.className = 'ptz-move';
        ptzMove.innerHTML = `
            <ha-icon class="right" icon="mdi:arrow-right"></ha-icon>
            <ha-icon class="left" icon="mdi:arrow-left"></ha-icon>
            <ha-icon class="up" icon="mdi:arrow-up"></ha-icon>
            <ha-icon class="down" icon="mdi:arrow-down"></ha-icon>
        `;
        ptz.appendChild(ptzMove);
        if (this.config.ptz.data_zoom_in && this.config.ptz.data_zoom_out) {
            const ptzZoom = document.createElement('div');
            ptzZoom.className = 'ptz-zoom';
            ptzZoom.innerHTML = `
                <ha-icon class="zoom_in" icon="mdi:plus"></ha-icon>
                <ha-icon class="zoom_out" icon="mdi:minus"></ha-icon>
            `;
            ptz.appendChild(ptzZoom);
        }
        card.appendChild(ptz);

        const handlePTZ = (ev) => {
            const [domain, service] = this.config.ptz.service.split('.', 2);
            const data = this.config.ptz['data_' + ev.target.className];
            if (data) {
                hass.callService(domain, service, data);
            }
        }

        const buttons = ptz.querySelectorAll('ha-icon');
        buttons.forEach(function (el) {
            el.addEventListener('click', handlePTZ);
        });
    }

    async renderGUI(hass) {
        const style = document.createElement('style');
        style.textContent = `
            ha-card {
                display: flex;
                justify-content: center;
                flex-direction: column;
                margin: auto;
                overflow: hidden;
                width: 100%;
                height: 100%;
                position: relative;
                background: black;
            }
            #video, .fix-safari {
                width: 100%;
                height: 100%;
                display: block;
                z-index: 0;
            }
            .box {
                position: absolute;
                left: 0px;
                right: 0px;
                top: 0px;
                background-color: var( --ha-picture-card-background-color, rgba(0, 0, 0, 0.3) );
                pointer-events: none;
            }
            .header {
                color: var(--ha-picture-card-text-color, white);
                margin: 14px 16px;
                display: none;
                font-size: 16px;
                line-height: 20px;
                word-wrap: break-word;
            }
            .spinner {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                --mdc-theme-primary: white;
            }
            ha-icon {
                color: white;
                position: absolute;
                cursor: pointer;
            }
            .pause {
                right: 5px;
                bottom: 5px;
                display: none;
            }
            .fullscreen {
                left: 5px;
                bottom: 5px;
            }
            .volume {
                right: 35px;
                bottom: 5px;
                display: none;
            }
            .ptz {
                position: absolute;
                top: 50%;
                right: 10px;
                transform: translateY(-50%);
                transition: opacity .3s ease-in-out;
                display: none;
                z-index: 10;
            }
            .ptz-move {
                position: relative;
                background-color: var( --ha-picture-card-background-color, rgba(0, 0, 0, 0.3) );
                border-radius: 50%;
                width: 80px;
                height: 80px;
            }
            .ptz-zoom {
                position: relative;
                margin-top: 10px;
                background-color: var( --ha-picture-card-background-color, rgba(0, 0, 0, 0.3) );
                border-radius: 4px;
                width: 80px;
                height: 40px;
            }
            .show {
                display: block;
            }
            .ptz:hover {
                opacity: 1 !important;
            }
            .up {
                top: 5px;
                left: 50%;
                transform: translateX(-50%);
            }
            .down {
                bottom: 5px;
                left: 50%;
                transform: translateX(-50%);
            }
            .left {
                left: 5px;
                top: 50%;
                transform: translateY(-50%);
            }
            .right {
                right: 5px;
                top: 50%;
                transform: translateY(-50%);
            }
            .zoom_out {
                left: 5px;
                top: 50%;
                transform: translateY(-50%);
            }
            .zoom_in {
                right: 5px;
                top: 50%;
                transform: translateY(-50%);
            }
            .state {
                right: 12px;
                top: 12px;
                cursor: default;
                opacity: 0.4;
            }
        `;
        this.appendChild(style);

        const card = document.createElement('ha-card');
        card.innerHTML = `
            <div class="fix-safari">
                <video id="video" autoplay controls playsinline></video>
            </div>
            <div class="box">
                <div class="header"></div>
            </div>
            <ha-icon class="state"></ha-icon>
        `;
        this.appendChild(card);

        const video = this.querySelector('#video');
        video.muted = this.config.muted !== false;
        video.poster = this.config.poster || '';

        // video.onstalled = video.onerror = () => {
        //     video.srcObject = new MediaStream(video.srcObject.getTracks());
        //     video.play().then(() => null, () => null);
        // };

        video.addEventListener('playing', () => {
            if (video.readyState >= 1) {
                this.status = this.config.title || '';
                this.setPTZVisibility(true);
            }
        });
        video.addEventListener('waiting', () => {
            this.setPTZVisibility(false);
        });

        video.onpause = () => {
            this.setPTZVisibility(false);
        };

        video.onplay = () => {
            this.setPTZVisibility(true);
        };
        // fix MSE in Safari
        video.addEventListener('ended', () => {
            console.debug("Auto resume on ended");
            video.play().then(() => null, () => null);
        });

        this.initPageVisibilityListener();

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    // console.debug("Video integsects:", entry.isIntersecting);
                    if (entry.isIntersecting) {
                        video.play().then(() => null, () => null);
                    } else {
                        video.pause();
                    }
                });
            },
            {threshold: this.config.intersection || 0.5}
        );
        observer.observe(video);

        if (this.config.ui) {
            this.renderCustomGUI(card);
        } else {
            // fix Chrome blinking while loading MSE
            // let mouseover = false;
            // video.onwaiting = () => {
            //     if (!mouseover) video.controls = false;
            // }
            // video.onplaying = () => {
            //     if (!mouseover) video.controls = true;
            // }
            // video.onmouseover = () => {
            //     mouseover = true;
            // }
            // video.onmouseout = () => {
            //     mouseover = false;
            // }
        }

        if (this.config.ptz) {
            this.renderPTZ(card, hass);
        }
    }

    set status(value) {
        const header = this.querySelector('.header');
        header.innerText = value;
        header.style.display = value ? 'block' : 'none';
    }

    set readyState(value) {
        const state = this.querySelector('.state');
        switch (value) {
            case 'websocket':
                state.icon = 'mdi:download-network-outline';
                break;
            case 'mse':
                state.icon = 'mdi:play-network-outline';
                break;

            case 'webrtc-pending':  // init WebRTC
                state.icon = 'mdi:lan-pending';
                break;
            case 'webrtc-connecting':  // connect to LAN or WAN IP
                state.icon = 'mdi:lan-connect';
                break;
            case 'webrtc-loading':  // load video stream
                state.icon = 'mdi:lan-check';
                break;
            case 'webrtc-restart':  // restart WebRTC
                state.icon = 'mdi:lan-disconnect';
                break;
            case 'webrtc':  // video stream switched to WebRTC
                state.icon = 'mdi:webrtc';
                break;
        }
    }

    setPTZVisibility(show) {
        const ptz = this.querySelector('.ptz');
        if (ptz) {
            if (show) {
                ptz.classList.add('show');
            } else {
                ptz.classList.remove('show');
            }
        }
    }

    setConfig(config) {
        if (typeof config.url !== 'string' && typeof config.entity !== 'string') {
            throw new Error('Missing `url` or `entity`');
        }
        if (config.ptz && !config.ptz.service) {
            throw new Error("Missing `service` for `ptz`");
        }

        this.config = config;
    }

    get isOpera() {
        // this integraion https://github.com/thomasloven/hass-fontawesome
        // breaks the `!!window.opera` check in all browsers
        return (!!window.opr && !!opr.addons) || navigator.userAgent.indexOf(' OPR/') >= 0;
    }

    getCardSize() {
        return 5;
    }

    static getStubConfig() {
        return {
            url: 'rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mov'
        }
    }

    initPageVisibilityListener() {
        var hidden, visibilityChange;
        if (typeof document.hidden !== "undefined") { // Opera 12.10 and Firefox 18 and later support
            hidden = "hidden";
            visibilityChange = "visibilitychange";
        } else if (typeof document.msHidden !== "undefined") {
            hidden = "msHidden";
            visibilityChange = "msvisibilitychange";
        } else if (typeof document.webkitHidden !== "undefined") {
            hidden = "webkitHidden";
            visibilityChange = "webkitvisibilitychange";
        }

        document.addEventListener(visibilityChange, () => {
            if (!document[hidden] && this.isConnected) {
                this.connectedCallback();
            } else {
                this.disconnectedCallback();
            }
        }, false);
    }

    async connectedCallback() {
        if (!this.config) return;

        if (!this.rendered) {
            await this.renderGUI(this.hass);
            this.rendered = true;
        }
        
        if (this.ws && this.config.background === true) return;

        if (!this.ws || [this.ws.CLOSING, this.ws.CLOSED].includes(this.ws.readyState)) {
            await this.initMSE(this.hass);
        }
    }

    disconnectedCallback(){
        if (this.config.background !== true) {
            this.subscriptions.forEach(callback => callback());
            this.subscriptions = [];
        }
    }
}

customElements.define('webrtc-camera', WebRTCCamera);

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'webrtc-camera',
    name: 'WebRTC Camera',
    preview: false,
    description: 'WebRTC Camera allows you to watch RTSP-camera stream without any delay',
});
