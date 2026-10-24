export const localSpeechModels = [
  {
    name: 'whisper',
    repository: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    files: [
      {
        path: 'config.json',
        size: 2243,
        sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
      },
      {
        path: 'generation_config.json',
        size: 3832,
        sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
      },
      {
        path: 'preprocessor_config.json',
        size: 339,
        sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
      },
      {
        path: 'tokenizer.json',
        size: 2480466,
        sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
      },
      {
        path: 'tokenizer_config.json',
        size: 282682,
        sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
      },
      {
        path: 'special_tokens_map.json',
        size: 2194,
        sha256: 'e67ae3a0aaa99abcd9f187138e12db1f65c16a14761c50ef10eef2c174a7a691',
      },
      {
        path: 'normalizer.json',
        size: 52666,
        sha256: 'bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd',
      },
      {
        path: 'added_tokens.json',
        size: 34604,
        sha256: '9715fd2243b6f06a5858b5e32950d2853f73dd5bc201aafcf76f5082a2d8acd1',
      },
      {
        path: 'onnx/encoder_model_quantized.onnx',
        size: 23201314,
        sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
      },
      {
        path: 'onnx/decoder_model_merged_quantized.onnx',
        size: 53693315,
        sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
      },
    ],
  },
  {
    name: 'kokoro',
    repository: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    files: [
      {
        path: 'config.json',
        size: 44,
        sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
      },
      {
        path: 'tokenizer.json',
        size: 3497,
        sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
      },
      {
        path: 'tokenizer_config.json',
        size: 113,
        sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
      },
      {
        path: 'onnx/model_quantized.onnx',
        size: 92361116,
        sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
      },
      {
        path: 'voices/af_heart.bin',
        size: 522240,
        sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
      },
      {
        path: 'voices/af_bella.bin',
        size: 522240,
        sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
      },
      {
        path: 'voices/bf_emma.bin',
        size: 522240,
        sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
      },
      {
        path: 'voices/bm_george.bin',
        size: 522240,
        sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
      },
      {
        path: 'voices/pf_dora.bin',
        size: 522240,
        sha256: '3da7b5b2d91847ebf5646f57631af6ececae3c29a89cd300f06edf9aa6cfe9ee',
      },
      {
        path: 'voices/pm_alex.bin',
        size: 522240,
        sha256: '0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a',
      },
      {
        path: 'voices/ef_dora.bin',
        size: 522240,
        sha256: 'f66ec66bd295acb18372e37008533a9a3228483ccd294e7538d5d9294ac9a532',
      },
      {
        path: 'voices/em_alex.bin',
        size: 522240,
        sha256: '27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95',
      },
      {
        path: 'voices/ff_siwis.bin',
        size: 522240,
        sha256: 'a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861',
      },
      {
        path: 'voices/hf_alpha.bin',
        size: 522240,
        sha256: '040be6a4425411cc01fda5fd06693c76bfa78572632852bc8cda9c99232ffb56',
      },
      {
        path: 'voices/hm_omega.bin',
        size: 522240,
        sha256: 'b02d9222d9ed00ce26b302173a862c2c93f96cc40b5c422b8d14910b9ff34137',
      },
      {
        path: 'voices/if_sara.bin',
        size: 522240,
        sha256: '409b69248798fcdc2542330c76953d230710f19b057e59cb82fdc3c4cf71265c',
      },
      {
        path: 'voices/im_nicola.bin',
        size: 522240,
        sha256: 'bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0',
      },
    ],
  },
] as const;
