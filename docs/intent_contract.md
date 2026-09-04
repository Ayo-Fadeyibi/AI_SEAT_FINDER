# FindaSpot - Intent Contract
This defines the exact shape of data passed between the Intent Parser and the Optimizer, so both can be built in parallel against a shared agreement.

## 1. Intent Parser output -> Optimizer input
`parse(query:str)` must return a Python dict with these keys:

```
{
    "zoneType": "quiet",
    "groupSize": 1,
    "requiredEquipment": ["power_outlet"],
    "accessibilityNeeds": null,
}
```

### zoneType (string)
Allowed values: ["quiet", "collaborative"]
Must match the values used in `data/seats.json`.
If the query doesn't specify, default to "quiet".

### groupSize (integer)
Allowed values: 1 and above
If not specified, default to 1.

### requiredEquipment (list of strings)
Allowed values: ["power_outlet", "projector"]
Empty list [] if nothing is specified. Must match equipment
strings used in seats.json.

### accessibilityNeeds (string or null)
Free text or null
null if not mentioned. 


If the LLM's JSON output doesn't parse cleanly, `parse()` should raise.


## 2. Seat Shape (defined in `data/seats.json`)

```
{
  "id": "S001",
  "zoneType": "quiet",
  "capacity": 1,
  "equipment": ["power_outlet"],
  "floor": 2,
  "location": "West wing, near window",
  "occupancyStatus": "available"
}
```

`occupancyStatus` is either "available" or "occupied".
This can come from hardcoded dataset during dev, then later the CV component.


## 3. Optimizer Output

`recommend(parsed_intent: dict, seats: list[dict])` returns either:
- a single seat dict that is the best match OR
- None - if no seat matches the criteria

## 4. Matching Rules
Note: For V1, we return just a single seat.
Can extend after this is working to do a list of all available seats, etc.

A seat is a candidiate if, in order:
1. occupancyStatus == available
2. capacity >= groupSize
3. zoneType == parsed_intent["zoneType"]
4. every item in parsed_intent["requiredEquipment"] is present in the seat's equipment list.

If multiple seats match, return the first match. (Extend for "ranking" of best seats later.)

### Fallback tier
If no available seat satisfies all four rules, `recommend()` returns the
first available seat instead of `None` (an "alternative", vs. a "perfect
match" that satisfies every rule). `recommend()` only returns `None` when
no seat has `occupancyStatus == "available"` at all. Ranking alternatives
is deferred to a later version, same as ranking perfect matches.
