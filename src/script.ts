import './assets/style.css';
import Alpine from 'alpinejs';
import byteSize from 'byte-size';
import CRC32 from 'crc-32';
import { v4 as uuidv4 } from 'uuid';

// @ts-ignore
window.Alpine = Alpine;

type AlpineData = {
  toasts: {
    id: string;
    severity: 'success' | 'warning' | 'error';
    message: string;
  }[];
  connecting: boolean;
  creating: boolean;

  isWebRTCSupported: boolean;
  wsStatus: 'needs_to_start' | 'error' | 'connected';
  ws: WebSocket | null;
  peer: RTCPeerConnection | null;
  dataChannel: RTCDataChannel | null;
  iceConnectionState: string | null;

  roomId: string | null;
  sending: boolean;
  sendingProgress: string | null;
  form: {
    file: File | null;
    fileSize: string | null;
  };
  receivedFileName: string | null;
  receivedFileType: string | null;
  receivedSize: string | null;
  receivedChecksum: number | null;
  receivedChunks: Map<
    number,
    Uint8Array<ArrayBuffer>
  > | null;
  received: {
    id: string;
    name: string;
    type: string;
    size: string;
    checksum: number | null;
    generatedChecksum: number | null;
    url: string | null;
    progress: {
      current: number;
      total: number;
      percent: number;
    } | null;
  }[];

  init(): void;
  onInput(file: File | null | undefined): void;
  start(type: 'connect' | 'create'): void;
  close(): void;
  download(name: string, url: string): void;
  send(): void;
  showToast(
    severity: 'success' | 'warning' | 'error',
    message: string,
  ): void;
  removeToast(id: string): void;
  getRandomNumber(length: number): number;
};

document.addEventListener('alpine:init', () => {
  Alpine.data<AlpineData, []>('app', () => ({
    toasts: [],
    connecting: false,
    creating: false,

    isWebRTCSupported: true,
    wsStatus: 'needs_to_start',
    ws: null,
    peer: null,
    dataChannel: null,
    iceConnectionState: null,

    roomId: null,
    sending: false,
    sendingProgress: null,
    form: {
      file: null,
      fileSize: null,
    },
    receivedFileName: null,
    receivedFileType: null,
    receivedSize: null,
    receivedChecksum: null,
    receivedChunks: null,
    received: [],

    init() {
      this.isWebRTCSupported = !!(
        window.RTCPeerConnection && window.RTCDataChannel
      );
    },

    onInput(file) {
      if (!file) return;
      this.form.file = file;
      this.form.fileSize = `${byteSize(file.size)}`;
    },

    async start(type) {
      if (type === 'connect') {
        if (!this.roomId) {
          this.showToast('error', 'Room ID is required');
          return;
        }
        this.connecting = true;

        // Validate room
        const roomStatus = (await (
          await fetch(`/rooms/${this.roomId}`)
        ).json()) as {
          valid: boolean;
          full: boolean;
        };

        if (!roomStatus.valid) {
          this.showToast('error', 'Invalid room ID');
          this.connecting = false;
          return;
        }

        if (roomStatus.full) {
          this.showToast('error', 'Room is full');
          this.connecting = false;
          return;
        }
      } else if (type === 'create') {
        this.creating = true;
        this.roomId = `${this.getRandomNumber(6)}`;

        // Make sure room doesn't exist
        const roomStatus = (await (
          await fetch(`/rooms/${this.roomId}`)
        ).json()) as {
          valid: boolean;
          full: boolean;
        };

        if (roomStatus.valid) {
          this.start('create'); // Try again
          return;
        }
      }

      const userId = uuidv4();
      this.ws = new WebSocket('/socket', [
        this.roomId!,
        userId,
      ]);
      this.peer = new RTCPeerConnection({
        iceServers: [
          {
            urls: 'stun:157.20.50.213:3478',
            username: 'sabily',
            credential: 'sabily',
          },
          {
            urls: 'turn:157.20.50.213:3478',
            username: 'sabily',
            credential: 'sabily',
          },
        ],
      });

      // WS

      this.ws.addEventListener('open', async () => {
        this.connecting = false;
        this.creating = false;

        this.dataChannel = this.peer!.createDataChannel(
          'fileTransfer',
          {
            ordered: true,
          },
        );
        this.dataChannel.binaryType = 'arraybuffer';
        this.dataChannel.bufferedAmountLowThreshold =
          32 * 1024; // 32 kB

        this.dataChannel.onmessage = (e) => {
          dataChannelOnMessage(e.data);
        };

        const offer = await this.peer!.createOffer();
        await this.peer!.setLocalDescription(offer);

        this.ws!.send(
          JSON.stringify({
            userId,
            data: {
              type: 'offer',
              offer: this.peer!.localDescription,
            },
          }),
        );
        this.wsStatus = 'connected';
      });

      this.ws.addEventListener('error', (err) => {
        console.log('ws: error', err);
        this.connecting = false;
        this.creating = false;
        this.wsStatus = 'error';

        this.showToast('error', 'Connection error');
      });

      this.ws.addEventListener('close', () => {
        this.close();
      });

      this.ws.addEventListener('message', async (event) => {
        // console.log("websocket:", eventData);
        const eventData = JSON.parse(event.data);
        if (eventData.userId === userId) return;

        if (eventData.data.type === 'offer') {
          await this.peer!.setRemoteDescription(
            new RTCSessionDescription(eventData.data.offer),
          );
          const answer = await this.peer!.createAnswer();
          await this.peer!.setLocalDescription(answer);
          this.ws!.send(
            JSON.stringify({
              userId,
              data: {
                type: 'answer',
                answer: this.peer!.localDescription,
              },
            }),
          );
        } else if (eventData.data.type === 'answer') {
          await this.peer!.setRemoteDescription(
            new RTCSessionDescription(
              eventData.data.answer,
            ),
          );
        } else if (eventData.data.type === 'candidate') {
          if (!eventData.data.candidate) return;

          await this.peer!.addIceCandidate(
            new RTCIceCandidate(eventData.data.candidate),
          );
        }
      });

      // Peer

      this.peer.oniceconnectionstatechange = () => {
        this.iceConnectionState =
          this.peer!.iceConnectionState;
      };

      this.peer.onicecandidate = (event) => {
        // console.log("ICE candidate:", event);
        this.ws!.send(
          JSON.stringify({
            userId,
            data: {
              type: 'candidate',
              candidate: event.candidate || null,
            },
          }),
        );
      };

      this.peer.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.dataChannel.binaryType = 'arraybuffer';
        this.dataChannel.bufferedAmountLowThreshold =
          32 * 1024; // 32 kB

        this.dataChannel.onmessage = (e) => {
          dataChannelOnMessage(e.data);
        };
      };

      const dataChannelOnMessage = async (data: any) => {
        if (data === 'DONE') {
          // Reassemble chunks
          const chunks = Array.from(
            this.receivedChunks!.entries(),
          )
            .sort(([a], [b]) => a - b)
            .map(([, data]) => data);

          const blob = new Blob(chunks, {
            type: this.receivedFileType!,
          });
          const url = URL.createObjectURL(blob);

          // Remove progress
          this.received.pop();

          // This is the final file
          this.received.push({
            id: uuidv4(),
            name: this.receivedFileName!,
            type: this.receivedFileType!,
            size: this.receivedSize!,
            checksum: this.receivedChecksum!,
            generatedChecksum: CRC32.buf(
              new Uint8Array(await blob.arrayBuffer()),
            ),
            url,
            progress: null,
          });

          this.receivedFileName = null;
          this.receivedFileType = null;
          this.receivedSize = null;
          this.receivedChecksum = null;
          this.receivedChunks = null;
        } else if (!this.receivedFileName) {
          this.receivedFileName = data || 'unknown';
        } else if (!this.receivedFileType) {
          this.receivedFileType = data;
        } else if (!this.receivedSize) {
          this.receivedSize = `${byteSize(Number.parseInt(data))}`;

          // For progress
          this.received.push({
            id: uuidv4(),
            name: this.receivedFileName,
            type: this.receivedFileType,
            size: this.receivedSize!,
            checksum: null,
            generatedChecksum: null,
            url: null,
            progress: {
              current: 0,
              total: Number.parseInt(data),
              percent: 0,
            },
          });
        } else if (!this.receivedChecksum) {
          this.receivedChecksum = Number.parseInt(data);
        } else {
          // Store chunk
          const buffer = data as ArrayBuffer;
          const view = new DataView(buffer);
          const sequenceNumber = view.getUint32(0);
          const chunkData = new Uint8Array(buffer, 4);

          if (!this.receivedChunks) {
            this.receivedChunks = new Map();
          }

          this.receivedChunks.set(
            sequenceNumber,
            chunkData,
          );

          // Get current progress (last element)
          const currentProgress =
            this.received[this.received.length - 1]
              .progress!;

          // Update progress
          currentProgress.current += buffer.byteLength;
          currentProgress.percent = Math.round(
            (currentProgress.current /
              currentProgress.total) *
              100,
          );
        }
      };
    },

    close() {
      this.roomId = null;
      this.sending = false;
      this.form.file = null;
      this.receivedFileName = null;
      this.receivedFileType = null;
      this.receivedSize = null;
      this.receivedChecksum = null;
      this.receivedChunks = null;
      this.received = [];

      this.ws?.close();
      this.dataChannel?.close();
      this.peer?.close();

      this.wsStatus = 'needs_to_start';
      this.ws = null;
      this.peer = null;
      this.dataChannel = null;
    },

    download(name: string, url: string) {
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
    },

    async send() {
      if (!this.form.file) {
        this.showToast('error', 'No file selected');
        return;
      }

      if (this.dataChannel?.readyState !== 'open') {
        this.showToast('error', 'Peer not connected');
        return;
      }

      this.sending = true;

      // Send metadata
      this.dataChannel.send(this.form.file.name);
      this.dataChannel.send(
        this.form.file.type.length === 0
          ? 'application/octet-stream'
          : this.form.file.type,
      );
      this.dataChannel.send(this.form.file.size.toString());

      // Send checksum
      const checksum = CRC32.buf(
        new Uint8Array(await this.form.file.arrayBuffer()),
      );
      this.dataChannel.send(checksum.toString());

      // Send file in chunks
      const fileSize = this.form.file.size;
      const chunkSize = 16 * 1024; // 16 kB chunks
      let sequenceNumber = 0;
      let offset = 0;
      let done = false;

      const fileReader = new FileReader();

      const readNextChunk = () => {
        if (offset >= fileSize) {
          if (done) return;
          this.dataChannel!.send('DONE');
          this.form.file = null;
          this.sending = false;
          this.sendingProgress = null;
          done = true;
          return;
        }

        const slice = this.form.file?.slice(
          offset,
          offset + chunkSize,
        );

        if (slice) {
          fileReader.readAsArrayBuffer(slice);
        }
      };

      fileReader.onload = (e) => {
        if (!e.target) return;

        // Pause if buffer exceeds the threshold
        const bufferThreshold = 64 * 1024; // 64 kB
        if (
          this.dataChannel!.bufferedAmount > bufferThreshold
        ) {
          return;
        }

        const data = e.target.result as ArrayBuffer;
        const chunkBuffer = new ArrayBuffer(
          4 + data.byteLength,
        );

        // Set sequence number
        new DataView(chunkBuffer).setUint32(
          0,
          sequenceNumber++,
        );

        // Set chunk data
        new Uint8Array(chunkBuffer).set(
          new Uint8Array(data),
          4,
        );

        this.dataChannel!.send(chunkBuffer);

        offset += data.byteLength;
        this.sendingProgress = `${Math.round((offset / fileSize) * 100)}%`;

        readNextChunk();
      };

      // Backpressure handling, resume when buffer is low
      this.dataChannel.onbufferedamountlow = () => {
        readNextChunk();
      };

      readNextChunk();
    },

    showToast(severity, message) {
      const id = uuidv4();
      this.toasts.push({
        id,
        severity,
        message,
      });

      setTimeout(() => {
        this.removeToast(id);
      }, 3000);
    },

    removeToast(id: string) {
      this.toasts = this.toasts.filter(
        (toast) => toast.id !== id,
      );
    },

    getRandomNumber(length) {
      if (length <= 0) {
        throw new Error(
          'Length must be a positive integer.',
        );
      }

      const min = 10 ** (length - 1);
      const max = 10 ** length - 1;
      const array = new Uint32Array(1);
      window.crypto.getRandomValues(array);

      // Ensure the number is within the range for the specified length
      return (array[0] % (max - min + 1)) + min;
    },
  }));
});

Alpine.start();
