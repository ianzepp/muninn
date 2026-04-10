package muninnframes

import (
	"errors"
	"testing"
)

func sampleFrame() Frame {
	return Frame{
		ID:        "550e8400-e29b-41d4-a716-446655440000",
		ParentID:  ptr("550e8400-e29b-41d4-a716-446655440001"),
		CreatedMS: 42,
		ExpiresIn: 0,
		From:      ptr("user-1"),
		Call:      "object:update",
		Status:    StatusDone,
		Trace: map[string]any{
			"room": "alpha",
		},
		Data: map[string]any{
			"x":  1.25,
			"ok": true,
		},
	}
}

func TestStatusIsTerminal(t *testing.T) {
	if StatusRequest.IsTerminal() {
		t.Fatal("request should not be terminal")
	}
	if !StatusDone.IsTerminal() {
		t.Fatal("done should be terminal")
	}
	if !StatusError.IsTerminal() {
		t.Fatal("error should be terminal")
	}
}

func TestEncodeDecodeRoundTripPreservesFrame(t *testing.T) {
	frame := sampleFrame()

	data, err := EncodeFrame(frame)
	if err != nil {
		t.Fatalf("encode failed: %v", err)
	}

	decoded, err := DecodeFrame(data)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}

	if decoded.ID != frame.ID {
		t.Fatalf("unexpected id: got %q want %q", decoded.ID, frame.ID)
	}
	if decoded.Call != frame.Call {
		t.Fatalf("unexpected call: got %q want %q", decoded.Call, frame.Call)
	}
	if decoded.Status != frame.Status {
		t.Fatalf("unexpected status: got %q want %q", decoded.Status, frame.Status)
	}
}

func TestDecodeFrameRejectsInvalidStatus(t *testing.T) {
	_, err := DecodeFrame([]byte(`{
		"id":"id-1",
		"created_ms":1,
		"expires_in":0,
		"call":"board:list",
		"status":"invalid",
		"data":{}
	}`))
	if err == nil {
		t.Fatal("expected decode to fail")
	}
	if !errors.Is(err, ErrInvalidStatus) {
		t.Fatalf("expected invalid status error, got %v", err)
	}
}

func TestEncodeFrameRejectsMissingData(t *testing.T) {
	frame := sampleFrame()
	frame.Data = nil

	_, err := EncodeFrame(frame)
	if err == nil {
		t.Fatal("expected validation error")
	}
}

func TestDecodeFrameDefaultsMissingDataToEmptyObject(t *testing.T) {
	_, err := DecodeFrame([]byte(`{
		"id":"id-1",
		"created_ms":1,
		"expires_in":0,
		"call":"board:list",
		"status":"request"
	}`))
	if err == nil {
		t.Fatal("expected decode to fail without object data")
	}
}

func TestDecodeFrameRejectsScalarData(t *testing.T) {
	_, err := DecodeFrame([]byte(`{
		"id":"id-1",
		"created_ms":1,
		"expires_in":0,
		"call":"board:list",
		"status":"request",
		"data":24
	}`))
	if err == nil {
		t.Fatal("expected decode to fail for scalar data")
	}
}

func ptr(value string) *string {
	return &value
}
