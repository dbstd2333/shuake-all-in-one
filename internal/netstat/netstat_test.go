// SPDX-License-Identifier: AGPL-3.0-or-later

package netstat

import (
	"strings"
	"testing"
)

const sample = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  123456     100    0    0    0     0          0         0   123456     100    0    0    0     0       0          0
  eth0: 1000000    2000    0    0    0     0          0         0   200000    1500    0    0    0     0       0          0
  ens5:     500       5    0    0    0     0          0         0       50       1    0    0    0     0       0          0
docker0:  999999     10    0    0    0     0          0         0   999999      10    0    0    0     0       0          0
vethab12: 777777     10    0    0    0     0          0         0   777777      10    0    0    0     0       0          0
`

func TestParseSkipsVirtualInterfaces(t *testing.T) {
	c, err := Parse(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	if c.Rx != 1000500 || c.Tx != 200050 {
		t.Fatalf("got rx=%d tx=%d", c.Rx, c.Tx)
	}
	if strings.Join(c.Interfaces, ",") != "eth0,ens5" {
		t.Fatalf("interfaces %v", c.Interfaces)
	}
}
