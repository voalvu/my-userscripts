// ==UserScript==
// @name         minimuxxerD - download muxxed audio-video streams from your x timeline
// @namespace
// @version      0.3
// @description  Bypassing requirement of external muxer, ffmpeg etc. by using MediaStream and manually splice a working mp4 file together from the binary data supplied to a MediaStream. IMPORTANT: IF YOU USE THIS TOOL, ONLY USE IT TO DOWNLOAD PUBLIC DOMAIN OR YOUR OWN UPLOADED MEDIA.
// @match        https://x.com/*
// @grant        none
// @author      voalvu
// ==/UserScript==

(async function() {
    'use strict';

    /**
     * Finds a box of the specified type within a buffer.
     * @param {ArrayBuffer} buffer - The input buffer.
     * @param {string} type - The 4-character box type (e.g., 'moov').
     * @returns {Object|null} The found box or null if not found.
     */
    function findBox(buffer, type) {
        let offset = 0;
        while (offset < buffer.byteLength) {
            const box = readBox(buffer, offset);
            if (!box) break;
            if (box.type === type) return box;
            offset += box.size;
        }
        return null;
    }

    /**
     * Finds a sub-box of the specified type within a parent box's data.
     * @param {Object} box - The parent box.
     * @param {string} type - The sub-box type to find.
     * @returns {Object|null} The found sub-box or null.
     */
    function findSubBox(box, type) {
        let offset = 0;
        while (offset < box.data.byteLength) {
            const subBox = readBox(box.data, offset);
            if (!subBox) break;
            if (subBox.type === type) return subBox;
            offset += subBox.size;
        }
        return null;
    }

    /**
     * Updates a 32-bit unsigned integer at a specific offset in a buffer.
     * @param {ArrayBuffer} buffer - The original buffer.
     * @param {number} offset - Offset where the uint32 is located.
     * @param {number} value - New value to set.
     * @returns {ArrayBuffer} New buffer with the updated value.
     */
    function updateUint32(buffer, offset, value) {
        const newBuffer = buffer.slice(0);
        const view = new DataView(newBuffer);
        view.setUint32(offset, value);
        return newBuffer;
    }

    /**
     * Serializes a box object back into an ArrayBuffer.
     * @param {Object} box - Box with size, type, and data or subBoxes.
     * @returns {ArrayBuffer} Serialized box buffer.
     */
    function serializeBox(box) {
        const data = box.data instanceof ArrayBuffer
            ? new Uint8Array(box.data)
            : box.subBoxes.map(serializeBox).reduce((acc, b) => acc.concat(Array.from(new Uint8Array(b))), []);
        const size = 8 + (data instanceof Uint8Array ? data.length : data.length);
        const buffer = new ArrayBuffer(size);
        const view = new DataView(buffer);
        view.setUint32(0, size);
        view.setUint8(4, box.type.charCodeAt(0));
        view.setUint8(5, box.type.charCodeAt(1));
        view.setUint8(6, box.type.charCodeAt(2));
        view.setUint8(7, box.type.charCodeAt(3));

        // Handle both Uint8Array and regular arrays
        if (data instanceof Uint8Array) {
            new Uint8Array(buffer).set(data, 8);
        } else {
            new Uint8Array(buffer).set(new Uint8Array(data), 8);
        }

        return buffer;
    }

    // Define container box types (expanded for completeness)
    const containerTypes = new Set([
        'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta', 'mvex',
        'meta', 'ilst', 'moof', 'traf', 'mfra' // Add more if your MP4 uses them
    ]);

    /**
     * Recursively parses an MP4 box tree.
     * @param {ArrayBuffer} buffer - The input buffer.
     * @param {number} offset - Starting offset.
     * @returns {Object|null} Parsed box object or null if invalid.
     */
    function parseBoxTree(buffer, offset = 0) {
        const box = readBox(buffer, offset);
        if (!box) {
            console.warn(`Failed to read box at offset ${offset}`);
            return null;
        }

        box.subBoxes = [];
        if (containerTypes.has(box.type)) {
            let subOffset = 0;
            while (subOffset < box.data.byteLength) {
                if (subOffset + 8 > box.data.byteLength) {
                    console.warn(`Incomplete box at subOffset ${subOffset} in '${box.type}'`);
                    break;
                }

                const subBox = parseBoxTree(box.data, subOffset);
                if (!subBox) {
                    console.warn(`Sub-box parsing failed at subOffset ${subOffset} in '${box.type}'`);
                    break;
                }
                box.subBoxes.push(subBox);
                subOffset += subBox.size;
            }
        }
        return box;
    }

    /**
     * Reads a single MP4 box from a buffer.
     * @param {ArrayBuffer} buffer - The input buffer.
     * @param {number} offset - Starting offset.
     * @returns {Object|null} Box object or null if invalid.
     */
    function readBox(buffer, offset) {
        if (offset + 8 > buffer.byteLength) {
            return null;
        }

        const view = new DataView(buffer, offset);
        let size = view.getUint32(0);
        const type = String.fromCharCode(
            view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)
        );
        let headerSize = 8;

        if (size === 1) {
            if (offset + 16 > buffer.byteLength) {
                return null;
            }
            size = Number(view.getBigUint64(8));
            headerSize = 16;
        } else if (size === 0) {
            size = buffer.byteLength - offset; // Extend to end of buffer
        }

        if (offset + size > buffer.byteLength) {
            return null;
        }

        return {
            size,
            type,
            offset: offset + headerSize,
            data: buffer.slice(offset + headerSize, offset + size)
        };
    }

    // Capture media
    class Media {
        constructor(id, initVideoSeg, initAudioSeg) {
            this.id = id;
            this.initVideoSeg = initVideoSeg;
            this.initAudioSeg = initAudioSeg;
            this.videoSegs = [];
            this.audioSegs = [];
            this.videoCodec = null;
            this.audioCodec = null;
        }
    }

    const medias = [];
    window.medias = medias;
    let debugged_video_audio_segs_by_id = {};
    const mediaSourceToId = new WeakMap();

    // Override XMLHttpRequest to intercept segments
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (url.match(/\.mp4|\.m4s/)) {
            this.addEventListener('load', () => {
                if (this.response instanceof ArrayBuffer || this.response instanceof Blob) {
                    // Extract media ID from URL - use a more reliable pattern if needed
                    const urlParts = this.responseURL.split('/');
                    const id = urlParts.length > 4 ? urlParts[4] : 'default';

                    if (!debugged_video_audio_segs_by_id[id]) {
                        debugged_video_audio_segs_by_id[id] = { init: null, videoSegs: [], initAudio: null, audioSegs: [] };
                    }

                    // Convert Blob to ArrayBuffer if needed
                    const processResponse = (response) => {
                        if (response instanceof Blob) {
                            return new Promise(resolve => {
                                const reader = new FileReader();
                                reader.onload = () => resolve(reader.result);
                                reader.readAsArrayBuffer(response);
                            });
                        }
                        return Promise.resolve(response);
                    };

                    processResponse(this.response).then(buffer => {
                        if (url.includes('/vid/')) {
                            if (url.includes('.mp4')) {
                                debugged_video_audio_segs_by_id[id].init = buffer;
                            } else if (url.includes('.m4s')) {
                                debugged_video_audio_segs_by_id[id].videoSegs.push(buffer);
                            }
                        } else if (url.includes('/aud/')) {
                            if (url.includes('.mp4')) {
                                debugged_video_audio_segs_by_id[id].initAudio = buffer;
                            } else if (url.includes('.m4s')) {
                                debugged_video_audio_segs_by_id[id].audioSegs.push(buffer);
                            }
                        }
                    });
                }
            });
        }
        originalOpen.apply(this, arguments);
    };

    // Associate MediaSource with media ID
    let mediaSourcesAdded = 0
    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function(mimeType) {
        //const mediaId = Object.keys(debugged_video_audio_segs_by_id)[0]; // Fallback if id not in scope
        //mediaSources.push(this);
      mediaSourcesAdded+=1
      const mediaId = Object.keys(debugged_video_audio_segs_by_id)[Math.floor(mediaSourcesAdded/2)];
      console.log(mediaSourcesAdded,mediaId)
        //console.log(mediaSources,Object.keys(debugged_video_audio_segs_by_id)[mediaSources.length-1])
        if (mediaId && !mediaSourceToId.has(this)) {
            mediaSourceToId.set(this, mediaId);

            // Detect codecs from mime type for better container compatibility
            if (mimeType.includes('video')) {
                const match = mimeType.match(/codecs="([^"]+)"/);
                if (match && match[1]) {
                    debugged_video_audio_segs_by_id[mediaId].videoCodec = match[1].split(',')[0];
                }
            } else if (mimeType.includes('audio')) {
                const match = mimeType.match(/codecs="([^"]+)"/);
                if (match && match[1]) {
                    debugged_video_audio_segs_by_id[mediaId].audioCodec = match[1];
                }
            }
        }

        return originalAddSourceBuffer.call(this, mimeType);
    };

    // Trigger muxing when stream ends
    const originalEndOfStream = MediaSource.prototype.endOfStream;
    MediaSource.prototype.endOfStream = function() {
        // Function to create and insert download buttons with custom cursor
    function addDownloadButtons(videoId) {
        const videoContainers = Array.from(document.querySelectorAll('video[aria-label="Embedded video"]'));
        //console.log(videoContainers)
        const videoContainer = videoContainers.find(v => v.poster.includes(videoId));
        if (!videoContainer) {
            console.error('Video container not found.');
            return;
        }
        console.log('found videoContainer',videoContainer,videoId)
        document.querySelector(`#vid-${videoId}`).remove()

        const videoMedia = medias.find(m => m.id === videoId && m.initVideoSeg !== null);
        const audioMedia = medias.find(m => m.id === videoId && m.initAudioSeg !== null);

        if (!videoMedia || !audioMedia) {
            console.error('Video or audio media not found.');
            return;
        }

        // Create video download button
        const videoButton = document.createElement('button');
        videoButton.textContent = 'Download Video 🎀';
        videoButton.style = `
            background: linear-gradient(45deg, #ff9eb5, #ff6f91);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 20px;
            margin-right: 10px;
            font-family: 'Comic Sans MS', cursive;
            font-size: 14px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.2);
            transition: transform 0.2s, box-shadow 0.2s;
        `;
        videoButton.addEventListener('click', () => {
            if (videoMedia.initVideoSeg && videoMedia.videoSegs.length > 0) {
                const fullBlob = new Blob([videoMedia.initVideoSeg, ...videoMedia.videoSegs], { type: 'video/mp4' });
                const url = URL.createObjectURL(fullBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${videoId}_video.mp4`;
                a.click();
                URL.revokeObjectURL(url);
                console.log('Video download triggered.');
            } else {
                console.error('No video data found.');
            }
        });

        // Create audio download button
        const audioButton = document.createElement('button');
        audioButton.textContent = 'Download Audio 🌸';
        audioButton.style = `
            background: linear-gradient(45deg, #a6e3e9, #71c7ec);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 20px;
            margin-right: 10px;
            font-family: 'Comic Sans MS', cursive;
            font-size: 14px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.2);
            transition: transform 0.2s, box-shadow 0.2s;
        `;
        audioButton.addEventListener('click', () => {
            if (audioMedia.initAudioSeg && audioMedia.audioSegs.length > 0) {
                const fullBlob = new Blob([audioMedia.initAudioSeg, ...audioMedia.audioSegs], { type: 'audio/mp4' });
                const url = URL.createObjectURL(fullBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${videoId}_audio.mp4`;
                a.click();
                URL.revokeObjectURL(url);
                console.log('Audio download triggered.');
            } else {
                console.error('No audio data found.');
            }
        });

        // Create combined download button
        const combinedButton = document.createElement('button');
        combinedButton.textContent = 'Download Combined ✨';
        combinedButton.style = `
            background: linear-gradient(45deg, #d4a5c4, #c77eb5);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 20px;
            font-family: 'Comic Sans MS', cursive;
            font-size: 14px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.2);
            transition: transform 0.2s, box-shadow 0.2s;
        `;
        combinedButton.addEventListener('click', () => {
            try{muxMedia(videoMedia,videoId)
               }
          catch{
            console.error('HORRIBLE DISASTER')
          }
        });

        // Insert buttons above the video player
        const buttonContainer = document.createElement('div');
        buttonContainer.style = `
            position: absolute;
            z-index: 9999;
            top: 10px;
            left: 10px;
            display: flex;
            flex-direction: row;
            gap: 10px;
        `;
        buttonContainer.appendChild(videoButton);
        buttonContainer.appendChild(audioButton);
        buttonContainer.appendChild(combinedButton);
        videoContainer.insertAdjacentElement('beforebegin', buttonContainer);
        console.log('Download buttons added.');
    }

    // Use MutationObserver to wait for the video container to appear
    const videosWithButtons = [];

        const mediaId = mediaSourceToId.get(this);
        console.log('mediaId at 387, ',mediaId)
        if (mediaId && debugged_video_audio_segs_by_id[mediaId]) {
            const media = debugged_video_audio_segs_by_id[mediaId];
            if (media.init && media.initAudio && media.videoSegs.length > 0 && media.audioSegs.length > 0) {
                console.log('ready to download')
                console.log(media,mediaId)
                media.id = mediaId
                medias.push(media)//muxMedia(media, mediaId);

                videosWithButtons.push(mediaId);
                addDownloadButtons(mediaId);
            }
        }
        originalEndOfStream.apply(this, arguments);
    };


    function muxMedia(media, videoId) {
        const videoInitArrayBuffer = media.init;
        const audioInitArrayBuffer = media.initAudio;
        const videoSegs = media.videoSegs;
        const audioSegs = media.audioSegs;

        // Extract ftyp from video init
        const ftypBox = findBox(videoInitArrayBuffer, 'ftyp');
        if (!ftypBox) return console.error('[MiniMuxxer] No ftyp box found');
        const ftypData = videoInitArrayBuffer.slice(ftypBox.offset - 8, ftypBox.offset - 8 + ftypBox.size);

        // Parse and update video moov
        const videoMoov = findBox(videoInitArrayBuffer, 'moov');
        if (!videoMoov) return console.error('[MiniMuxxer] No moov in video init');
        const videoMoovTree = parseBoxTree(videoInitArrayBuffer, videoMoov.offset - 8);
        const videoMvhd = videoMoovTree.subBoxes.find(b => b.type === 'mvhd');
        const videoTrak = videoMoovTree.subBoxes.find(b => b.type === 'trak');
        const videoMvex = videoMoovTree.subBoxes.find(b => b.type === 'mvex');
        if (!videoMvhd || !videoTrak || !videoMvex) return console.error('[MiniMuxxer] Missing video moov sub-boxes');

        // Parse and update audio moov
        const audioMoov = findBox(audioInitArrayBuffer, 'moov');
        if (!audioMoov) return console.error('[MiniMuxxer] No moov in audio init');
        const audioMoovTree = parseBoxTree(audioInitArrayBuffer, audioMoov.offset - 8);
        const audioTrak = audioMoovTree.subBoxes.find(b => b.type === 'trak');
        const audioMvex = audioMoovTree.subBoxes.find(b => b.type === 'mvex');
        if (!audioTrak || !audioMvex) return console.error('[MiniMuxxer] Missing audio moov sub-boxes');

        // Update audio track IDs in moov
        const audioTkhd = audioTrak.subBoxes.find(b => b.type === 'tkhd');
        if (!audioTkhd) return console.error('[MiniMuxxer] No tkhd in audio trak');

        // Set track ID of audio track to 2
        let audioTkhdView = new DataView(audioTkhd.data);
        const audioTkhdVersion = audioTkhdView.getUint8(0);
        const audioTkhdTrackIdOffset = audioTkhdVersion === 0 ? 12 : 20;
        audioTkhd.data = updateUint32(audioTkhd.data, audioTkhdTrackIdOffset, 2);

        // Update audio media header to reference track ID 2
        const audioMdia = audioTrak.subBoxes.find(b => b.type === 'mdia');
        if (audioMdia) {
            const audioMdhd = audioMdia.subBoxes.find(b => b.type === 'mdhd');
            const audioHdlr = audioMdia.subBoxes.find(b => b.type === 'hdlr');
            // No need to update mdhd, but make sure it's present
            if (!audioMdhd) console.warn('[MiniMuxxer] No mdhd in audio mdia');
            // No need to update hdlr, but make sure it's present
            if (!audioHdlr) console.warn('[MiniMuxxer] No hdlr in audio mdia');
        }

        const audioTrex = audioMvex.subBoxes.find(b => b.type === 'trex');
        if (!audioTrex) return console.error('[MiniMuxxer] No trex in audio mvex');
        audioTrex.data = updateUint32(audioTrex.data, 8, 2); // Set audio track ID to 2 in trex

        // Update mvhd to set next_track_id to 3
        // First determine mvhd version to find correct offset
        const mvhdView = new DataView(videoMvhd.data);
        const mvhdVersion = mvhdView.getUint8(0);
        const nextTrackIdOffset = mvhdVersion === 0 ? 96 : 108;
        videoMvhd.data = updateUint32(videoMvhd.data, nextTrackIdOffset, 3);

        // Combine moov sub-boxes - keep only one mvex with trexs for both tracks
        const combinedMvex = {
            type: 'mvex',
            subBoxes: [
                videoMvex.subBoxes.find(b => b.type === 'trex'),
                audioTrex
            ]
        };

        const newMoovSubBoxes = [
            videoMvhd,
            videoTrak,
            audioTrak,
            combinedMvex
        ];

        const newMoov = { type: 'moov', subBoxes: newMoovSubBoxes };
        const newMoovBuffer = serializeBox(newMoov);

        // Process segments with unique sequence numbers and timestamps
        let seq = 1;
        const interleavedSegs = [];
        const minSegs = Math.min(videoSegs.length, audioSegs.length);

        // Get timescales from moov structures
        const videoTimescale = getTimescale(videoMoovTree);
        const audioTimescale = getTimescale(audioMoovTree);

        // Prepare for interleaving - we'll use the base decode times to synchronize
        let videoDuration = 0;
        let audioDuration = 0;

        // First pass - analyze all segments to determine proper timing
        const videoInfo = [];
        const audioInfo = [];

        for (let i = 0; i < minSegs; i++) {
            const vInfo = analyzeSegment(videoSegs[i], false);
            const aInfo = analyzeSegment(audioSegs[i], true);

            videoInfo.push(vInfo);
            audioInfo.push(aInfo);

            // Accumulate durations for proper timing
            videoDuration += vInfo.duration || estimateFrameDuration(vInfo.sampleCount, videoTimescale);
            audioDuration += aInfo.duration || estimateFrameDuration(aInfo.sampleCount, audioTimescale);
        }

        // Second pass - interleave segments with corrected timing
        let videoBaseTime = 0;
        let audioBaseTime = 0;

        for (let i = 0; i < minSegs; i++) {
            // Update and add video segment
            const processedVideo = processSegment(
                videoSegs[i],
                seq++,
                false,
                videoBaseTime,
                videoInfo[i]
            );

            // Update video base time for next segment
            videoBaseTime += videoInfo[i].duration ||
                             estimateFrameDuration(videoInfo[i].sampleCount, videoTimescale);

            // Update and add audio segment
            const processedAudio = processSegment(
                audioSegs[i],
                seq++,
                true,
                audioBaseTime,
                audioInfo[i]
            );

            // Update audio base time for next segment
            audioBaseTime += audioInfo[i].duration ||
                             estimateFrameDuration(audioInfo[i].sampleCount, audioTimescale);

            interleavedSegs.push(processedVideo, processedAudio);
        }

        // Combine all parts into final MP4
        const allBuffers = [ftypData, newMoovBuffer, ...interleavedSegs];
        const totalLength = allBuffers.reduce((acc, b) => acc + b.byteLength, 0);
        const combinedBuffer = new Uint8Array(totalLength);
        let offset = 0;
        for (const buf of allBuffers) {
            combinedBuffer.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        }

        // Trigger download
        const combinedBlob = new Blob([combinedBuffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(combinedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${videoId}_combined.mp4`;
        a.click();
        URL.revokeObjectURL(url);
        console.log('[MiniMuxxer] MP4 file muxed and downloaded successfully');
    }

    // Helper function to extract timescale from moov
    function getTimescale(moovTree) {
        const mvhd = moovTree.subBoxes.find(b => b.type === 'mvhd');
        if (mvhd) {
            const view = new DataView(mvhd.data);
            const version = view.getUint8(0);
            // Timescale is at offset 12 for version 0, offset 20 for version 1
            return view.getUint32(version === 0 ? 12 : 20);
        }
        return 90000; // Default timescale as fallback
    }

    // Helper to analyze a segment for timing information
    function analyzeSegment(segBuffer, isAudio) {
        const result = {
            baseTime: 0,
            duration: 0,
            sampleCount: 0,
            isAudio: isAudio
        };

        try {
            const moofBox = findBox(segBuffer, 'moof');
            if (!moofBox) return result;

            const moofTree = parseBoxTree(segBuffer, moofBox.offset - 8);
            const traf = moofTree.subBoxes.find(b => b.type === 'traf');
            if (!traf) return result;

            // Get base decode time from tfdt
            const tfdt = traf.subBoxes.find(b => b.type === 'tfdt');
            if (tfdt) {
                const tfdtView = new DataView(tfdt.data);
                const version = tfdtView.getUint8(0);

                if (version === 0) {
                    result.baseTime = tfdtView.getUint32(4);
                } else if (version === 1) {
                    const highBits = tfdtView.getUint32(4);
                    const lowBits = tfdtView.getUint32(8);
                    result.baseTime = (BigInt(highBits) << 32n) | BigInt(lowBits);
                }
            }

            // Get sample count and duration information from trun
            const trun = traf.subBoxes.find(b => b.type === 'trun');
            if (trun) {
                const trunView = new DataView(trun.data);
                const flags = trunView.getUint32(0) & 0xFFFFFF;
                result.sampleCount = trunView.getUint32(4);

                // Calculate total duration if sample durations are present
                if (flags & 0x100) { // sample-duration-present
                    let offset = 8; // Header size
                    if (flags & 0x1) offset += 4; // data-offset-present
                    if (flags & 0x4) offset += 4; // first-sample-flags-present

                    let totalDuration = 0;
                    for (let i = 0; i < result.sampleCount; i++) {
                        totalDuration += trunView.getUint32(offset);
                        offset += 4;
                        if (flags & 0x200) offset += 4; // sample-size-present
                        if (flags & 0x400) offset += 4; // sample-flags-present
                        if (flags & 0x800) offset += 4; // sample-composition-time-offsets-present
                    }
                    result.duration = totalDuration;
                } else {
                    // Try to get default sample duration from tfhd
                    const tfhd = traf.subBoxes.find(b => b.type === 'tfhd');
                    if (tfhd) {
                        const tfhdView = new DataView(tfhd.data);
                        const tfhdFlags = tfhdView.getUint32(0) & 0xFFFFFF;
                        let offset = 8; // Base offset after track ID
                        if (tfhdFlags & 0x1) offset += 8; // base-data-offset-present
                        if (tfhdFlags & 0x2) offset += 4; // sample-description-index-present
                        if (tfhdFlags & 0x8) { // default-sample-duration-present
                            const defaultDuration = tfhdView.getUint32(offset);
                            result.duration = defaultDuration * result.sampleCount;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[MiniMuxxer] Error analyzing segment', e);
        }

        return result;
    }

    // Estimate frame duration based on sample count and typical rates
    function estimateFrameDuration(sampleCount, timescale) {
        if (!sampleCount) return 0;

        // For video (assuming 30fps)
        if (timescale >= 10000) {
            return Math.round(timescale / 30 * sampleCount);
        }
        // For audio (assuming 44.1kHz sample rate)
        else {
            return sampleCount;
        }
    }

    // Process a segment with updated timing
    function processSegment(segBuffer, seq, isAudio, baseTime, segInfo) {
        const result = [];
        let offset = 0;

        while (offset < segBuffer.byteLength) {
            const box = readBox(segBuffer, offset);
            if (!box) break;

            if (box.type === 'styp') {
                // Skip styp box, not needed in final file
            } else if (box.type === 'moof') {
                const moofTree = parseBoxTree(segBuffer, offset);
                if (!moofTree) {
                    offset += box.size;
                    continue;
                }

                // Update mfhd sequence number
                const mfhd = moofTree.subBoxes.find(b => b.type === 'mfhd');
                if (mfhd) {
                    const mfhdView = new DataView(mfhd.data);
                    mfhdView.setUint32(4, seq); // Sequence number at offset 4
                }

                // Update track ID and timing information
                const traf = moofTree.subBoxes.find(b => b.type === 'traf');
                if (traf) {
                    // Update track ID for audio segments
                    const tfhd = traf.subBoxes.find(b => b.type === 'tfhd');
                    if (tfhd && isAudio) {
                        tfhd.data = updateUint32(tfhd.data, 8, 2); // Set track ID to 2
                    }

                    // Update base media decode time in tfdt
                    const tfdt = traf.subBoxes.find(b => b.type === 'tfdt');
                    if (tfdt) {
                        const tfdtView = new DataView(tfdt.data);
                        const version = tfdtView.getUint8(0);

                        if (version === 0) {
                            const currentTime = tfdtView.getUint32(4);
                            tfdtView.setUint32(4, Number(baseTime));
                        } else if (version === 1) {
                            const newTime = BigInt(baseTime);
                            tfdtView.setUint32(4, Number(newTime >> 32n)); // high bits
                            tfdtView.setUint32(8, Number(newTime & 0xFFFFFFFFn)); // low bits
                        }
                    }

                    // Update data offset in trun if present
                    const trun = traf.subBoxes.find(b => b.type === 'trun');
                    if (trun) {
                        const trunView = new DataView(trun.data);
                        const flags = trunView.getUint32(0) & 0xFFFFFF;

                        if (flags & 0x1) { // data-offset-present
                            // We'll update this later in a second pass
                            // after we know the full size of the moof box
                        }
                    }
                }

                // Add the updated moof box
                const updatedMoof = serializeBox(moofTree);
                result.push(updatedMoof);
            } else if (box.type === 'mdat') {
                // Just add the mdat box as is
                result.push(segBuffer.slice(offset, offset + box.size));
            } else {
                // Include any other box types
                result.push(segBuffer.slice(offset, offset + box.size));
            }

            offset += box.size;
        }

        // Combine all parts of the processed segment
        const totalLength = result.reduce((acc, b) => acc + b.byteLength, 0);
        const combinedSegment = new Uint8Array(totalLength);
        let pos = 0;
        for (const buf of result) {
            combinedSegment.set(new Uint8Array(buf), pos);
            pos += buf.byteLength;
        }

        return combinedSegment.buffer;
    }
    let prevVideoContainersCount = 0
    let prevIds = []
    let vcIdsWithloadingAdded = []
    const observer = new MutationObserver((mutations, obs) => {
        const videoContainers = document.querySelectorAll('video[aria-label="Embedded video"]');
        const currIds = []
        prevVideoContainersCount = videoContainers.length

        if(prevVideoContainersCount < videoContainers.length){
          console.log('containers added!')
        }else if(prevVideoContainersCount == videoContainers.length){
          console.log('same container amount!')
        }else{
          console.log('container count decreased')
        }
        for(let vc of videoContainers){
          const vcId = vc.poster.split('/')[4]
          console.log(vc.poster.split('/')[4])
          currIds.push(vcId)
          if(!vcIdsWithloadingAdded.includes(vcId)){
          const loadingIndicator = document.createElement('p');
        loadingIndicator.textContent = 'Let video play before download...';
        loadingIndicator.style = `
            background: linear-gradient(45deg, #ffffff, #000000);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 20px;
            font-family: 'Comic Sans MS', cursive;
            font-size: 14px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.2);
            transition: transform 0.2s, box-shadow 0.2s;
        `;
        loadingIndicator.addEventListener('click', () => {
            try{muxMedia(videoMedia,videoId)
               }
          catch{
            console.error('HORRIBLE DISASTER')
          }
        });

        // Insert buttons above the video player
        const loadingContainer = document.createElement('div');
        loadingContainer.style = `
            position: absolute;
            z-index: 9999;
            top: 10px;
            left: 10px;
            display: flex;
            flex-direction: row;
            gap: 10px;
        `;
            loadingContainer.id = `vid-${vcId}`;
        loadingContainer.appendChild(loadingIndicator);
        vc.insertAdjacentElement('beforebegin', loadingContainer);
          vcIdsWithloadingAdded.push(vcId)
        console.log('wait for download added.');
        }}
        console.log(prevIds,currIds);
        console.log(prevIds.filter(p=>currIds.includes(p)))
        console.log(currIds.filter(c=>prevIds.includes(c)))
        console.log(videoContainers,videoContainers.length)
        console.log(debugged_video_audio_segs_by_id,Object.keys(debugged_video_audio_segs_by_id).length)
    });

    // Start observing the document body for changes
    observer.observe(document.body, { childList: true, subtree: true });

})();
