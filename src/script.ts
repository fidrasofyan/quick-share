import "./assets/style.css";
import Alpine from "alpinejs";
import byteSize from "byte-size";
import { v4 as uuidv4 } from "uuid";

// @ts-ignore
window.Alpine = Alpine;

type AlpineData = {
  isWebRTCSupported: boolean;
  wsStatus: "needs_to_start" | "error" | "connected";
  ws: WebSocket | null;
  peer: RTCPeerConnection | null;
  dataChannel: RTCDataChannel | null;
  iceConnectionState: string | null;

  toasts: {
    id: string;
    severity: "success" | "warning" | "error";
    message: string;
  }[];

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
  receivedChunks: ArrayBuffer[];
  received: {
    name: string;
    type: string;
    size: string;
    url: string | null;
    progress: {
      current: number;
      total: number;
      percent: number;
    } | null;
  }[];

  init(): void;
  onInput(file: File | null | undefined): void;
  start(type: "connect" | "create"): void;
  close(): void;
  download(name: string, url: string): void;
  send(): void;
  showToast(severity: "success" | "warning" | "error", message: string): void;
  removeToast(id: string): void;
  getRandomNumber(length: number): number;
};

document.addEventListener("alpine:init", () => {
  Alpine.data<AlpineData, []>("app", () => ({
    isWebRTCSupported: true,
    wsStatus: "needs_to_start",
    ws: null,
    peer: null,
    dataChannel: null,
    iceConnectionState: null,

    toasts: [],

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
    receivedChunks: [],
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
      if (type === "connect") {
        if (!this.roomId) {
          this.showToast("error", "Room ID is required");
          return;
        }

        // Validate room
        const roomStatus = (await (
          await fetch(`/rooms/${this.roomId}`)
        ).json()) as {
          valid: boolean;
          full: boolean;
        };

        if (!roomStatus.valid) {
          this.showToast("error", "Invalid room ID");
          return;
        }

        if (roomStatus.full) {
          this.showToast("error", "Room is full");
          return;
        }
      } else if (type === "create") {
        this.roomId = `${this.getRandomNumber(6)}`;

        // Make sure room doesn't exist
        const roomStatus = (await (
          await fetch(`/rooms/${this.roomId}`)
        ).json()) as {
          valid: boolean;
          full: boolean;
        };

        if (roomStatus.valid) {
          this.start("create"); // Try again
          return;
        }
      }

      const userId = uuidv4();
      this.ws = new WebSocket("/socket", [this.roomId!, userId]);
      this.peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      // WS

      this.ws.addEventListener("open", async () => {
        // console.log("ws: open");
        this.dataChannel = this.peer!.createDataChannel("fileTransfer", {
          ordered: true,
        });
        this.dataChannel.bufferedAmountLowThreshold = 32 * 1024; // 32 kB
        this.dataChannel.onmessage = (e) => {
          processData(e.data);
        };

        const offer = await this.peer!.createOffer();
        await this.peer!.setLocalDescription(offer);
        this.ws!.send(
          JSON.stringify({
            userId,
            data: {
              type: "offer",
              offer: this.peer!.localDescription,
            },
          })
        );
        this.wsStatus = "connected";
      });

      this.ws.addEventListener("message", async (event) => {
        // console.log("websocket:", eventData);
        const eventData = JSON.parse(event.data);
        if (eventData.userId === userId) return;

        if (eventData.data.type === "offer") {
          await this.peer!.setRemoteDescription(
            new RTCSessionDescription(eventData.data.offer)
          );
          const answer = await this.peer!.createAnswer();
          await this.peer!.setLocalDescription(answer);
          this.ws!.send(
            JSON.stringify({
              userId,
              data: {
                type: "answer",
                answer: this.peer!.localDescription,
              },
            })
          );
        } else if (eventData.data.type === "answer") {
          await this.peer!.setRemoteDescription(
            new RTCSessionDescription(eventData.data.answer)
          );
        } else if (eventData.data.type === "candidate") {
          if (!eventData.data.candidate) return;

          await this.peer!.addIceCandidate(
            new RTCIceCandidate(eventData.data.candidate)
          );
        }
      });

      this.ws.addEventListener("error", (err) => {
        console.log("ws: error", err);
        this.wsStatus = "error";

        this.showToast("error", "Connection error");
      });

      this.ws.addEventListener("close", () => {
        // console.log("ws: close");
        this.wsStatus = "needs_to_start";
      });

      // Peer

      this.peer.oniceconnectionstatechange = () => {
        this.iceConnectionState = this.peer!.iceConnectionState;
      };

      this.peer.onicecandidate = (event) => {
        // console.log("ICE candidate:", event);
        this.ws!.send(
          JSON.stringify({
            userId,
            data: {
              type: "candidate",
              candidate: event.candidate || null,
            },
          })
        );
      };

      this.peer.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.dataChannel.bufferedAmountLowThreshold = 32 * 1024; // 32 kB
        this.dataChannel.onmessage = (e) => {
          processData(e.data);
        };
      };

      const processData = (data: any) => {
        if (data === "DONE") {
          const url = URL.createObjectURL(
            new Blob(this.receivedChunks, {
              type: this.receivedFileType!,
            })
          );
          this.received.pop();
          this.received.push({
            name: this.receivedFileName!,
            type: this.receivedFileType!,
            size: this.receivedSize!,
            url,
            progress: null,
          });

          this.receivedFileName = null;
          this.receivedFileType = null;
          this.receivedSize = null;
          this.receivedChunks = [];
        } else if (!this.receivedFileName) {
          this.receivedFileName = data || "unknown";
        } else if (!this.receivedFileType) {
          this.receivedFileType = data;
        } else if (!this.receivedSize) {
          this.receivedSize = `${byteSize(Number.parseInt(data))}`;

          this.received.push({
            name: this.receivedFileName,
            type: this.receivedFileType,
            size: this.receivedSize!,
            url: null,
            progress: {
              current: 0,
              total: Number.parseInt(data),
              percent: 0,
            },
          });
        } else {
          const currentProgress =
            this.received[this.received.length - 1].progress!;

          let current = 0;
          if (data instanceof ArrayBuffer) {
            current = data.byteLength;
          } else if (data instanceof Blob) {
            current = data.size;
          }

          currentProgress.current += current;
          currentProgress.percent = Math.round(
            (currentProgress.current / currentProgress.total) * 100
          );

          this.receivedChunks.push(data);
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
      this.receivedChunks = [];
      this.received = [];

      this.ws?.close();
      this.dataChannel?.close();
      this.peer?.close();

      this.wsStatus = "needs_to_start";
      this.ws = null;
      this.peer = null;
      this.dataChannel = null;
    },

    download(name: string, url: string) {
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
    },

    send() {
      // console.log(this.dataChannel?.readyState);

      if (!this.form.file) {
        this.showToast("error", "No file selected");
        return;
      }

      if (this.dataChannel?.readyState !== "open") {
        this.showToast("error", "Peer not connected");
        return;
      }

      this.sending = true;
      // console.log("Sending file:", this.form.file.name);

      // Send metadata
      this.dataChannel.send(this.form.file.name);
      this.dataChannel.send(
        this.form.file.type.length === 0
          ? "application/octet-stream"
          : this.form.file.type
      );
      // @ts-ignore
      this.dataChannel.send(this.form.file.size);

      // Send file
      const fileSize = this.form.file.size;
      const chunkSize = 16 * 1024; // 16 kB chunks
      let offset = 0;

      const readSlice = (offset: number) => {
        const slice = this.form.file?.slice(offset, offset + chunkSize);
        const reader = new FileReader();

        reader.onload = (e) => {
          if (!e.target) return;

          // Pause if buffer exceeds the threshold
          const bufferThreshold = 512 * 1024; // 512 kB
          if (this.dataChannel!.bufferedAmount > bufferThreshold) {
            // Resume when buffer is below the threshold
            this.dataChannel!.onbufferedamountlow = () => {
              readSlice(offset);
            };
          } else {
            this.dataChannel!.send(e.target.result as any);
            offset += (e.target.result as ArrayBuffer).byteLength;
            this.sendingProgress = `${Math.round((offset / fileSize) * 100)}%`;

            if (offset < fileSize) {
              readSlice(offset); // Recursively send next chunk
            } else {
              this.form.file = null;
              this.dataChannel!.send("DONE");
              this.sending = false;
              // console.log("File sent!");
            }
          }
        };

        if (slice) {
          reader.readAsArrayBuffer(slice);
        }
      };

      readSlice(offset);
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
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
    },

    getRandomNumber(length) {
      if (length <= 0) {
        throw new Error("Length must be a positive integer.");
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
