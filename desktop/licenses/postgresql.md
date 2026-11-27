# PostgreSQL

Nod runs PostgreSQL 17 on your computer to store your data. The binaries come from
[embedded-postgres-binaries](https://github.com/zonkyio/embedded-postgres-binaries), published
under the Apache License 2.0. The macOS and Windows builds repackage the PostgreSQL binaries
published by EnterpriseDB.

## PostgreSQL License

PostgreSQL Database Management System (also known as Postgres, formerly known as Postgres95)

Portions Copyright (c) 1996-2025, The PostgreSQL Global Development Group

Portions Copyright (c) 1994, The Regents of the University of California

Permission to use, copy, modify, and distribute this software and its documentation for any
purpose, without fee, and without a written agreement is hereby granted, provided that the above
copyright notice and this paragraph and the following two paragraphs appear in all copies.

IN NO EVENT SHALL THE UNIVERSITY OF CALIFORNIA BE LIABLE TO ANY PARTY FOR DIRECT, INDIRECT,
SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS, ARISING OUT OF THE USE OF
THIS SOFTWARE AND ITS DOCUMENTATION, EVEN IF THE UNIVERSITY OF CALIFORNIA HAS BEEN ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

THE UNIVERSITY OF CALIFORNIA SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE SOFTWARE
PROVIDED HEREUNDER IS ON AN "AS IS" BASIS, AND THE UNIVERSITY OF CALIFORNIA HAS NO OBLIGATIONS TO
PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.

## Bundled libraries

The binaries include shared libraries that keep their own licenses: ICU (Unicode License),
OpenSSL (Apache License 2.0 or OpenSSL License), libxml2 (MIT), zlib (zlib License), LZ4
(BSD 2-Clause), Zstandard (BSD), XZ Utils (public domain and 0BSD), MIT Kerberos (MIT),
libedit (BSD), OSSP uuid (MIT-style), and GNU libiconv and gettext runtime (LGPL 2.1 or later,
dynamically linked).

The LGPL 2.1 text is at https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html. You may replace
the libiconv and gettext libraries in the `lib` folder with your own builds. Their source is at
https://ftp.gnu.org/gnu/libiconv/ and https://ftp.gnu.org/gnu/gettext/. To get the exact source of
the versions Nod ships, open an issue at https://github.com/n8n-io/nod/issues for at least three
years after Nod stops shipping them.
