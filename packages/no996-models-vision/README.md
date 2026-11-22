# @newbiecheng/no996-models-vision

Static data-only vision weights bundle for No996 Studio (`@newbiecheng/dsh-no996-editor` >= `0.20.0`).

Contains only verified model weights, a machine-readable `manifest.json`, and upstream Apache-2.0 license notices. No install scripts, executables, or runtime binaries are included.

## Included Weights (16,993,554 bytes unpacked)

| File | Model | Capability | Bytes | SHA-256 | License |
|---|---|---|---:|---|---|
| `models/portrait.onnx` | MODNet (`model_fp16.onnx`) | Portrait alpha matting | 12,984,781 | `25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6` | Apache-2.0 |
| `models/face.task` | MediaPipe Face Landmarker | Facial landmarks (`4` faces max, no identity/tracking) | 3,758,596 | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` | Apache-2.0 |
| `models/person.tflite` | MediaPipe Selfie Segmenter Landscape | Person segmentation | 250,177 | `490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e` | Apache-2.0 |

## Provenance

- MODNet: https://github.com/ZHKKKe/MODNet & https://huggingface.co/Xenova/modnet/tree/fa2fa546052fba4c08921230a26cc69a333fca12
- MediaPipe: https://github.com/google-ai-edge/mediapipe
