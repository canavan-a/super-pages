package com.superpagesapp;

import java.security.GeneralSecurityException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * scrypt (RFC 7914), byte-for-byte the same as @noble/hashes' scrypt the JS
 * side used to run. Native because in Hermes a key file's 2^15 cost took
 * several seconds and froze the UI; here it is a fraction of that, off the JS
 * thread. Plain Java with no Android dependencies so it can be checked against
 * the RFC's test vectors with a bare JDK.
 */
public final class Scrypt {
  private Scrypt() {}

  public static byte[] derive(byte[] pass, byte[] salt, int n, int r, int p, int dkLen)
      throws GeneralSecurityException {
    if (n < 2 || (n & (n - 1)) != 0) throw new IllegalArgumentException("N must be a power of 2");
    Mac mac = Mac.getInstance("HmacSHA256");
    // SecretKeySpec rejects an empty key; HMAC zero-pads keys, so one zero
    // byte is the same key.
    mac.init(new SecretKeySpec(pass.length == 0 ? new byte[1] : pass, "HmacSHA256"));

    int blockInts = 32 * r;
    byte[] b = pbkdf2(mac, salt, p * 128 * r);
    int[] x = new int[blockInts];
    int[] y = new int[blockInts];
    int[] v = new int[blockInts * n];
    for (int i = 0; i < p; i++) {
      int off = i * 128 * r;
      for (int k = 0; k < blockInts; k++) x[k] = le32(b, off + 4 * k);
      for (int k = 0; k < n; k++) {
        System.arraycopy(x, 0, v, k * blockInts, blockInts);
        blockMix(x, y, r);
      }
      for (int k = 0; k < n; k++) {
        int j = x[(2 * r - 1) * 16] & (n - 1);
        for (int m = 0; m < blockInts; m++) x[m] ^= v[j * blockInts + m];
        blockMix(x, y, r);
      }
      for (int k = 0; k < blockInts; k++) put32(b, off + 4 * k, x[k]);
    }
    return pbkdf2(mac, b, dkLen);
  }

  /** PBKDF2-HMAC-SHA256 with one iteration, as scrypt uses it. */
  private static byte[] pbkdf2(Mac mac, byte[] salt, int len) {
    byte[] out = new byte[len];
    byte[] idx = new byte[4];
    for (int i = 1, pos = 0; pos < len; i++, pos += 32) {
      idx[0] = (byte) (i >>> 24);
      idx[1] = (byte) (i >>> 16);
      idx[2] = (byte) (i >>> 8);
      idx[3] = (byte) i;
      mac.update(salt);
      byte[] t = mac.doFinal(idx);
      System.arraycopy(t, 0, out, pos, Math.min(32, len - pos));
    }
    return out;
  }

  private static void blockMix(int[] b, int[] y, int r) {
    int[] x = new int[16];
    System.arraycopy(b, (2 * r - 1) * 16, x, 0, 16);
    for (int i = 0; i < 2 * r; i++) {
      for (int k = 0; k < 16; k++) x[k] ^= b[i * 16 + k];
      salsa8(x);
      System.arraycopy(x, 0, y, i * 16, 16);
    }
    for (int i = 0; i < r; i++) {
      System.arraycopy(y, 2 * i * 16, b, i * 16, 16);
      System.arraycopy(y, (2 * i + 1) * 16, b, (r + i) * 16, 16);
    }
  }

  private static void salsa8(int[] b) {
    int x0 = b[0], x1 = b[1], x2 = b[2], x3 = b[3], x4 = b[4], x5 = b[5], x6 = b[6], x7 = b[7];
    int x8 = b[8], x9 = b[9], x10 = b[10], x11 = b[11], x12 = b[12], x13 = b[13], x14 = b[14], x15 = b[15];
    for (int i = 0; i < 8; i += 2) {
      x4 ^= Integer.rotateLeft(x0 + x12, 7);
      x8 ^= Integer.rotateLeft(x4 + x0, 9);
      x12 ^= Integer.rotateLeft(x8 + x4, 13);
      x0 ^= Integer.rotateLeft(x12 + x8, 18);
      x9 ^= Integer.rotateLeft(x5 + x1, 7);
      x13 ^= Integer.rotateLeft(x9 + x5, 9);
      x1 ^= Integer.rotateLeft(x13 + x9, 13);
      x5 ^= Integer.rotateLeft(x1 + x13, 18);
      x14 ^= Integer.rotateLeft(x10 + x6, 7);
      x2 ^= Integer.rotateLeft(x14 + x10, 9);
      x6 ^= Integer.rotateLeft(x2 + x14, 13);
      x10 ^= Integer.rotateLeft(x6 + x2, 18);
      x3 ^= Integer.rotateLeft(x15 + x11, 7);
      x7 ^= Integer.rotateLeft(x3 + x15, 9);
      x11 ^= Integer.rotateLeft(x7 + x3, 13);
      x15 ^= Integer.rotateLeft(x11 + x7, 18);
      x1 ^= Integer.rotateLeft(x0 + x3, 7);
      x2 ^= Integer.rotateLeft(x1 + x0, 9);
      x3 ^= Integer.rotateLeft(x2 + x1, 13);
      x0 ^= Integer.rotateLeft(x3 + x2, 18);
      x6 ^= Integer.rotateLeft(x5 + x4, 7);
      x7 ^= Integer.rotateLeft(x6 + x5, 9);
      x4 ^= Integer.rotateLeft(x7 + x6, 13);
      x5 ^= Integer.rotateLeft(x4 + x7, 18);
      x11 ^= Integer.rotateLeft(x10 + x9, 7);
      x8 ^= Integer.rotateLeft(x11 + x10, 9);
      x9 ^= Integer.rotateLeft(x8 + x11, 13);
      x10 ^= Integer.rotateLeft(x9 + x8, 18);
      x12 ^= Integer.rotateLeft(x15 + x14, 7);
      x13 ^= Integer.rotateLeft(x12 + x15, 9);
      x14 ^= Integer.rotateLeft(x13 + x12, 13);
      x15 ^= Integer.rotateLeft(x14 + x13, 18);
    }
    b[0] += x0; b[1] += x1; b[2] += x2; b[3] += x3; b[4] += x4; b[5] += x5; b[6] += x6; b[7] += x7;
    b[8] += x8; b[9] += x9; b[10] += x10; b[11] += x11; b[12] += x12; b[13] += x13; b[14] += x14; b[15] += x15;
  }

  private static int le32(byte[] b, int i) {
    return (b[i] & 0xff) | (b[i + 1] & 0xff) << 8 | (b[i + 2] & 0xff) << 16 | (b[i + 3] & 0xff) << 24;
  }

  private static void put32(byte[] b, int i, int v) {
    b[i] = (byte) v;
    b[i + 1] = (byte) (v >>> 8);
    b[i + 2] = (byte) (v >>> 16);
    b[i + 3] = (byte) (v >>> 24);
  }
}
