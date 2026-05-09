package api

import (
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

func TestFrameMsgpackKeys(t *testing.T) {
	data, err := msgpack.Marshal(frame{
		SID:  7,
		Kind: "snapshot",
		GVR:  "/v1, Resource=nodes",
		List: []interface{}{map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Node",
			"metadata": map[string]interface{}{
				"uid":  "node-1",
				"name": "node-1",
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	var got map[string]interface{}
	if err := msgpack.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got["sid"] != int8(7) && got["sid"] != uint64(7) && got["sid"] != int64(7) {
		t.Fatalf("sid key missing or unexpected: %#v", got)
	}
	if got["kind"] != "snapshot" {
		t.Fatalf("kind key missing or unexpected: %#v", got)
	}
	if got["list"] == nil {
		t.Fatalf("list key missing: %#v", got)
	}
}
